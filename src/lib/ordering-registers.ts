import { randomUUID } from "node:crypto";
import { getSql, withTransaction } from "@/lib/db";
import { ensureOrderingPosSchema } from "@/lib/ordering-pos-schema";
import { canManagePos, type OrderingActor } from "@/lib/ordering-route-auth";
import { sendEpsonPrint } from "@/lib/ordering-hardware";

export class RegisterError extends Error {}

function cents(value: unknown, label: string, allowZero = false) {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < (allowZero ? 0 : 1)) throw new RegisterError(`${label} must be a valid amount.`);
  return amount;
}

async function terminalForStation(stationKey: string, actor: OrderingActor) {
  const key = stationKey.trim().toLowerCase();
  if (!key) throw new RegisterError("Assign this device to a POS station in Settings → Hardware first.");
  const sql = getSql();
  const station = (await sql`SELECT * FROM ordering_payment_stations WHERE business='Corner Deli' AND station_key=${key} AND active=TRUE LIMIT 1`)[0];
  if (!station) throw new RegisterError("This POS station is not configured.");
  if (!station.receipt_printer_id) throw new RegisterError("This station is not connected to a register printer or cash drawer.");
  const terminalKey=String(station.shared_register_key||station.station_key).trim().toLowerCase(),name=String(station.shared_register_key||station.name);
  const id=randomUUID();
  const terminal=(await sql`INSERT INTO ordering_pos_terminals(id,business,name,terminal_key,terminal_type,location_label,allow_cash,allow_offline_cash,last_seen_at) VALUES(${id},'Corner Deli',${name},${terminalKey},'pos',${station.name},TRUE,TRUE,NOW()) ON CONFLICT(business,terminal_key) DO UPDATE SET name=EXCLUDED.name,active=TRUE,last_seen_at=NOW(),updated_at=NOW() RETURNING *`)[0];
  await sql`INSERT INTO ordering_pos_audit_events(id,business,event_type,employee_id,terminal_id,actor,details) VALUES(${randomUUID()},'Corner Deli','register_station_seen',${actor.id},${terminal.id},${actor.name},${JSON.stringify({stationKey:key,terminalKey})}::jsonb)`;
  return {station,terminal};
}

export async function registerDashboard(stationKey:string,actor:OrderingActor){
  await ensureOrderingPosSchema();
  const {station,terminal}=await terminalForStation(stationKey,actor),sql=getSql();
  const session=(await sql`SELECT session.*,employees.name employee_name FROM ordering_register_sessions session LEFT JOIN employees ON employees.id=session.employee_id WHERE session.terminal_id=${terminal.id} AND session.status IN('open','counting','needs_review') ORDER BY session.opened_at DESC LIMIT 1`)[0]||null;
  const movements=session?await sql`SELECT movement.*,employees.name employee_name FROM ordering_cash_drawer_movements movement LEFT JOIN employees ON employees.id=movement.employee_id WHERE movement.register_session_id=${session.id} ORDER BY movement.created_at DESC LIMIT 100`:[];
  const recent=await sql`SELECT session.*,terminal.name terminal_name FROM ordering_register_sessions session JOIN ordering_pos_terminals terminal ON terminal.id=session.terminal_id WHERE session.business='Corner Deli' AND session.terminal_id=${terminal.id} ORDER BY session.opened_at DESC LIMIT 20`;
  return {station:{name:station.name,stationKey:station.station_key,sharedRegisterKey:station.shared_register_key},terminal:{id:terminal.id,name:terminal.name,terminalKey:terminal.terminal_key},session,movements,recent,canManage:canManagePos(actor)};
}

export async function updateRegister(input:{stationKey:string;action:string;amountCents?:number;reason?:string;notes?:string;actor:OrderingActor}){
  await ensureOrderingPosSchema();
  const {station,terminal}=await terminalForStation(input.stationKey,input.actor),reason=String(input.reason||"").trim().slice(0,500),notes=String(input.notes||"").trim().slice(0,1000);
  if(input.action==="no_sale"){
    if(!canManagePos(input.actor))throw new RegisterError("Manager or owner authorization is required to open the drawer without a sale.");
    const sql=getSql(),current=(await sql`SELECT * FROM ordering_register_sessions WHERE terminal_id=${terminal.id} AND status='open' ORDER BY opened_at DESC LIMIT 1`)[0];
    if(!current)throw new RegisterError("Open the register before using No Sale.");
    const printer=(await sql`SELECT * FROM ordering_hardware_devices WHERE id=${station.receipt_printer_id} AND business='Corner Deli' AND device_type='printer' AND active=TRUE LIMIT 1`)[0];
    if(!printer)throw new RegisterError("The receipt printer assigned to this station is not available.");
    if(printer.adapter_key!=="network-printer"||printer.adapter_config?.cashDrawerEnabled!==true)throw new RegisterError("Enable the cash drawer on this station's network receipt printer first.");
    try{await sendEpsonPrint(printer.adapter_config,[],{openCashDrawer:true,drawerOnly:true})}catch(error){throw new RegisterError(error instanceof Error?error.message:"The cash drawer could not be opened.")}
    await sql`INSERT INTO ordering_pos_audit_events(id,business,event_type,employee_id,terminal_id,actor,reason,details) VALUES(${randomUUID()},'Corner Deli','cash_drawer_no_sale',${input.actor.id},${terminal.id},${input.actor.name},'Manager No Sale',${JSON.stringify({registerSessionId:current.id,stationKey:station.station_key,printerId:printer.id,printerName:printer.name})}::jsonb)`;
    return current;
  }
  return withTransaction(async()=>{
    const sql=getSql();
    const current=(await sql`SELECT * FROM ordering_register_sessions WHERE terminal_id=${terminal.id} AND status IN('open','counting','needs_review') ORDER BY opened_at DESC LIMIT 1 FOR UPDATE`)[0];
    if(input.action==="open"){
      if(current)throw new RegisterError("This register is already open or awaiting review.");
      const opening=cents(input.amountCents,"Opening cash",true),id=randomUUID();
      const session=(await sql`INSERT INTO ordering_register_sessions(id,business,terminal_id,employee_id,status,opening_cash_cents,expected_cash_cents,opened_by,notes) VALUES(${id},'Corner Deli',${terminal.id},${input.actor.id},'open',${opening},${opening},${input.actor.id},${notes}) RETURNING *`)[0];
      if(opening>0)await sql`INSERT INTO ordering_cash_drawer_movements(id,register_session_id,movement_type,delta_cash_cents,reason,employee_id,created_by,details) VALUES(${randomUUID()},${id},'opening_float',${opening},'Opening cash',${input.actor.id},${input.actor.id},'{}'::jsonb)`;
      await sql`INSERT INTO ordering_pos_audit_events(id,business,event_type,employee_id,terminal_id,actor,details) VALUES(${randomUUID()},'Corner Deli','register_opened',${input.actor.id},${terminal.id},${input.actor.name},${JSON.stringify({openingCashCents:opening})}::jsonb)`;
      return session;
    }
    if(!current)throw new RegisterError("Open the register first.");
    if(input.action==="paid_in"||input.action==="paid_out"||input.action==="drop"){
      if(!canManagePos(input.actor))throw new RegisterError("Manager or owner approval is required for cash movements.");
      if(current.status!=="open")throw new RegisterError("Cash movements cannot be entered while the register is counting or awaiting review.");
      if(reason.length<3)throw new RegisterError("Enter a reason for this cash movement.");
      const amount=cents(input.amountCents,"Cash movement"),delta=input.action==="paid_in"?amount:-amount;
      if(Number(current.expected_cash_cents)+delta<0)throw new RegisterError("This movement exceeds the expected cash in the drawer.");
      await sql`INSERT INTO ordering_cash_drawer_movements(id,register_session_id,movement_type,delta_cash_cents,reason,employee_id,approved_by,created_by,details) VALUES(${randomUUID()},${current.id},${input.action},${delta},${reason},${input.actor.id},${input.actor.id},${input.actor.id},'{}'::jsonb)`;
      await sql`UPDATE ordering_register_sessions SET expected_cash_cents=expected_cash_cents+${delta} WHERE id=${current.id}`;
    }else if(input.action==="start_count"){
      if(current.status!=="open")throw new RegisterError("This register is not ready to count.");
      await sql`UPDATE ordering_register_sessions SET status='counting' WHERE id=${current.id}`;
    }else if(input.action==="close"){
      if(current.status!=="counting")throw new RegisterError("Start the blind drawer count first.");
      const counted=cents(input.amountCents,"Counted cash",true),overShort=counted-Number(current.expected_cash_cents),status=overShort===0?'closed':'needs_review';
      await sql`UPDATE ordering_register_sessions SET counted_cash_cents=${counted},over_short_cents=${overShort},status=${status},closed_by=CASE WHEN ${status}='closed' THEN ${input.actor.id} ELSE '' END,closed_at=CASE WHEN ${status}='closed' THEN NOW() ELSE NULL END,notes=CONCAT_WS(E'\n',NULLIF(notes,''),NULLIF(${notes},'')) WHERE id=${current.id}`;
      await sql`INSERT INTO ordering_pos_audit_events(id,business,event_type,employee_id,terminal_id,actor,reason,details) VALUES(${randomUUID()},'Corner Deli',${status==='closed'?'register_closed':'register_count_variance'},${input.actor.id},${terminal.id},${input.actor.name},${notes},${JSON.stringify({countedCashCents:counted,expectedCashCents:Number(current.expected_cash_cents),overShortCents:overShort})}::jsonb)`;
    }else if(input.action==="approve_variance"){
      if(!canManagePos(input.actor))throw new RegisterError("Manager or owner approval is required.");
      if(current.status!=="needs_review")throw new RegisterError("This register does not have a variance awaiting review.");
      if(reason.length<3)throw new RegisterError("Enter a reason for approving the variance.");
      await sql`UPDATE ordering_register_sessions SET status='closed',closed_by=${input.actor.id},closed_at=NOW(),notes=CONCAT_WS(E'\n',NULLIF(notes,''),${`Variance approved: ${reason}`}) WHERE id=${current.id}`;
      await sql`INSERT INTO ordering_pos_audit_events(id,business,event_type,employee_id,terminal_id,actor,reason,details) VALUES(${randomUUID()},'Corner Deli','register_variance_approved',${input.actor.id},${terminal.id},${input.actor.name},${reason},${JSON.stringify({overShortCents:Number(current.over_short_cents)})}::jsonb)`;
    }else throw new RegisterError("Unknown register action.");
    return (await sql`SELECT * FROM ordering_register_sessions WHERE id=${current.id}`)[0];
  });
}
