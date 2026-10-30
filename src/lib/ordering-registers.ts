import { randomUUID } from "node:crypto";
import { getSql, withTransaction } from "@/lib/db";
import { ensureOrderingPosSchema } from "@/lib/ordering-pos-schema";
import { canManagePos, type OrderingActor } from "@/lib/ordering-route-auth";
import { sendEpsonPrint } from "@/lib/ordering-hardware";
import { deliverSms } from "@/lib/sms-notifications";
import { cashToRemoveCents, tillLabel, tillResetCents } from "@/lib/till-reset-rules";

export class RegisterError extends Error {}

function cents(value: unknown, label: string, allowZero = false) {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < (allowZero ? 0 : 1)) throw new RegisterError(`${label} must be a valid amount.`);
  return amount;
}

const money=(c:number)=>`$${(c/100).toFixed(2)}`;
function tillReset(terminal:Record<string,any>){return {resetCents:tillResetCents({terminalKey:terminal.terminal_key,name:terminal.name,resetCashCents:terminal.reset_cash_cents}),label:tillLabel({terminalKey:terminal.terminal_key,name:terminal.name}),configured:terminal.reset_cash_cents!=null}}

/** What the till should open with: the amount the last closeout confirmed was left in it. */
async function lastReset(terminalId:string){
  const sql=getSql();
  return (await sql`SELECT id,reset_confirmed_cents,reset_confirmed_by_name,reset_confirmed_at FROM ordering_register_sessions WHERE terminal_id=${terminalId} AND status='closed' AND reset_confirmed_at IS NOT NULL ORDER BY reset_confirmed_at DESC LIMIT 1`)[0]||null;
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
  const session=(await sql`SELECT session.*,employees.name employee_name FROM ordering_register_sessions session LEFT JOIN employees ON employees.id=session.employee_id WHERE session.terminal_id=${terminal.id} AND session.status IN('open','counting','needs_review','resetting') ORDER BY session.opened_at DESC LIMIT 1`)[0]||null;
  const movements=session?await sql`SELECT movement.*,employees.name employee_name FROM ordering_cash_drawer_movements movement LEFT JOIN employees ON employees.id=movement.employee_id WHERE movement.register_session_id=${session.id} ORDER BY movement.created_at DESC LIMIT 100`:[];
  const recent=await sql`SELECT session.*,terminal.name terminal_name FROM ordering_register_sessions session JOIN ordering_pos_terminals terminal ON terminal.id=session.terminal_id WHERE session.business='Corner Deli' AND session.terminal_id=${terminal.id} ORDER BY session.opened_at DESC LIMIT 20`;
  return {station:{name:station.name,stationKey:station.station_key,sharedRegisterKey:station.shared_register_key},terminal:{id:terminal.id,name:terminal.name,terminalKey:terminal.terminal_key},till:tillReset(terminal),lastReset:await lastReset(terminal.id),session,movements,recent,canManage:canManagePos(actor)};
}

export async function updateRegister(input:{stationKey:string;action:string;amountCents?:number;reason?:string;notes?:string;lowOnOnes?:boolean;actor:OrderingActor}){
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
  const updated=await withTransaction(async()=>{
    const sql=getSql();
    const current=(await sql`SELECT * FROM ordering_register_sessions WHERE terminal_id=${terminal.id} AND status IN('open','counting','needs_review','resetting') ORDER BY opened_at DESC LIMIT 1 FOR UPDATE`)[0];
    const till=tillReset(terminal);
    if(input.action==="set_reset_amount"){
      if(!canManagePos(input.actor))throw new RegisterError("Manager or owner approval is required to change the till reset amount.");
      const amount=cents(input.amountCents,"Reset amount",true);
      await sql`UPDATE ordering_pos_terminals SET reset_cash_cents=${amount},updated_at=NOW() WHERE id=${terminal.id}`;
      if(current?.status==="resetting")await sql`UPDATE ordering_register_sessions SET reset_expected_cents=${amount} WHERE id=${current.id}`;
      await sql`INSERT INTO ordering_pos_audit_events(id,business,event_type,employee_id,terminal_id,actor,details) VALUES(${randomUUID()},'Corner Deli','register_reset_amount_changed',${input.actor.id},${terminal.id},${input.actor.name},${JSON.stringify({previousResetCents:till.resetCents,resetCents:amount})}::jsonb)`;
      return current||{terminal_id:terminal.id,reset_cash_cents:amount};
    }
    if(input.action==="open"){
      if(current)throw new RegisterError("This register is already open or awaiting review.");
      // Opens with what the last closeout confirmed was left in the till (or the till's reset amount the first time).
      const previous=await lastReset(terminal.id),expectedOpening=previous?Number(previous.reset_confirmed_cents):till.resetCents;
      const opening=input.amountCents==null?expectedOpening:cents(input.amountCents,"Opening cash",true),id=randomUUID();
      if(opening!==expectedOpening&&notes.length<3)throw new RegisterError(`This till should have ${money(expectedOpening)} in it${previous?` (confirmed by ${previous.reset_confirmed_by_name||"staff"} at the last closeout)`:""}. Enter a note explaining the different amount.`);
      const session=(await sql`INSERT INTO ordering_register_sessions(id,business,terminal_id,employee_id,status,opening_cash_cents,expected_cash_cents,opened_by,notes) VALUES(${id},'Corner Deli',${terminal.id},${input.actor.id},'open',${opening},${opening},${input.actor.id},${notes}) RETURNING *`)[0];
      if(opening>0)await sql`INSERT INTO ordering_cash_drawer_movements(id,register_session_id,movement_type,delta_cash_cents,reason,employee_id,created_by,details) VALUES(${randomUUID()},${id},'opening_float',${opening},'Opening cash',${input.actor.id},${input.actor.id},'{}'::jsonb)`;
      await sql`INSERT INTO ordering_pos_audit_events(id,business,event_type,employee_id,terminal_id,actor,details) VALUES(${randomUUID()},'Corner Deli','register_opened',${input.actor.id},${terminal.id},${input.actor.name},${JSON.stringify({openingCashCents:opening,expectedOpeningCents:expectedOpening,previousSessionId:previous?.id||null,matchesConfirmedReset:opening===expectedOpening})}::jsonb)`;
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
      if(typeof input.lowOnOnes!=="boolean")throw new RegisterError("Answer whether the drawer has less than $30 in $1 bills.");
      const counted=cents(input.amountCents,"Counted cash",true),overShort=counted-Number(current.expected_cash_cents),status=overShort===0?'resetting':'needs_review';
      await sql`UPDATE ordering_register_sessions SET counted_cash_cents=${counted},over_short_cents=${overShort},status=${status},reset_expected_cents=${till.resetCents},notes=CONCAT_WS(E'\n',NULLIF(notes,''),NULLIF(${notes},'')) WHERE id=${current.id}`;
      await sql`INSERT INTO ordering_pos_audit_events(id,business,event_type,employee_id,terminal_id,actor,reason,details) VALUES(${randomUUID()},'Corner Deli',${status==='resetting'?'register_counted':'register_count_variance'},${input.actor.id},${terminal.id},${input.actor.name},${notes},${JSON.stringify({countedCashCents:counted,expectedCashCents:Number(current.expected_cash_cents),overShortCents:overShort,lowOnOneDollarBills:input.lowOnOnes})}::jsonb)`;
    }else if(input.action==="approve_variance"){
      if(!canManagePos(input.actor))throw new RegisterError("Manager or owner approval is required.");
      if(current.status!=="needs_review")throw new RegisterError("This register does not have a variance awaiting review.");
      if(reason.length<3)throw new RegisterError("Enter a reason for approving the variance.");
      await sql`UPDATE ordering_register_sessions SET status='resetting',reset_expected_cents=${till.resetCents},notes=CONCAT_WS(E'\n',NULLIF(notes,''),${`Variance approved: ${reason}`}) WHERE id=${current.id}`;
      await sql`INSERT INTO ordering_pos_audit_events(id,business,event_type,employee_id,terminal_id,actor,reason,details) VALUES(${randomUUID()},'Corner Deli','register_variance_approved',${input.actor.id},${terminal.id},${input.actor.name},${reason},${JSON.stringify({overShortCents:Number(current.over_short_cents)})}::jsonb)`;
    }else if(input.action==="confirm_reset"){
      // Closeout is not finished until someone confirms what was left in the till; the next opening uses it.
      if(current.status!=="resetting")throw new RegisterError("Finish the drawer count before confirming the till reset.");
      const expected=current.reset_expected_cents==null?till.resetCents:Number(current.reset_expected_cents);
      const left=input.amountCents==null?expected:cents(input.amountCents,"Amount left in the till",true);
      if(left!==expected&&reason.length<3)throw new RegisterError(`The ${till.label} should be reset to ${money(expected)}. Enter a note explaining why it has ${money(left)}.`);
      await sql`UPDATE ordering_register_sessions SET status='closed',closed_by=${input.actor.id},closed_at=NOW(),reset_expected_cents=${expected},reset_confirmed_cents=${left},reset_confirmed_by=${input.actor.id},reset_confirmed_by_name=${input.actor.name},reset_confirmed_at=NOW(),reset_note=${left===expected?"":reason} WHERE id=${current.id}`;
      await sql`INSERT INTO ordering_pos_audit_events(id,business,event_type,employee_id,terminal_id,actor,reason,details) VALUES(${randomUUID()},'Corner Deli','register_closed',${input.actor.id},${terminal.id},${input.actor.name},${left===expected?"":reason},${JSON.stringify({registerSessionId:current.id,countedCashCents:Number(current.counted_cash_cents),resetExpectedCents:expected,resetConfirmedCents:left,removedForDepositCents:cashToRemoveCents(Number(current.counted_cash_cents),left)})}::jsonb)`;
    }else throw new RegisterError("Unknown register action.");
    return (await sql`SELECT * FROM ordering_register_sessions WHERE id=${current.id}`)[0];
  });
  if(input.action==="close"&&input.lowOnOnes===true){
    const sql=getSql(),recipients=(await sql`SELECT id,name,phone,sms_opt_in FROM employees WHERE business='Corner Deli' AND active=TRUE AND pos_role='owner' ORDER BY name`) as Array<{id:string;name:string;phone:string;sms_opt_in:boolean}>;
    const alert=await deliverSms({recipients:recipients.map(row=>({id:String(row.id),name:String(row.name),phone:String(row.phone||""),smsOptIn:Boolean(row.sms_opt_in)})),text:()=>`Corner Deli till alert: ${terminal.name} has less than $30 in $1 bills. Reported by ${input.actor.name} during close-out.`});
    await sql`INSERT INTO ordering_pos_audit_events(id,business,event_type,employee_id,terminal_id,actor,reason,details) VALUES(${randomUUID()},'Corner Deli','register_low_ones_alert',${input.actor.id},${terminal.id},${input.actor.name},'Less than $30 in $1 bills',${JSON.stringify({registerSessionId:updated.id,smsProvider:alert.provider,smsConfigured:alert.configured,smsSent:alert.sent,smsFailed:alert.failed,smsSkipped:alert.skipped})}::jsonb)`;
    return {...updated,lowOnOnesAlert:alert};
  }
  return updated;
}
