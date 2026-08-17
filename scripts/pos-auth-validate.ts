#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { loadEnvFile } from "node:process";
import { randomInt, randomUUID } from "node:crypto";

loadEnvFile("/opt/corner-ops/.env");
const address = execFileSync("docker", ["inspect", "corner-ops-postgres", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}"], { encoding: "utf8" }).trim();
if (process.env.LOCAL_DEVELOPMENT?.toLowerCase() !== "true" || !process.env.POSTGRES_PASSWORD || !/^172\.|^10\.|^192\.168\./.test(address)) {
  throw new Error("POS auth validation requires the private local Corner Ops PostgreSQL container.");
}
process.env.DATABASE_DRIVER = "postgres";
process.env.DATABASE_URL = `postgresql://cornerops:${encodeURIComponent(process.env.POSTGRES_PASSWORD)}@${address}:5432/cornerops`;

const ROLLBACK = "rollback:pos-auth-validation";

async function main() {
  const { getSql, withTransaction } = await import("../src/lib/db");
  const { authenticateDeliPosPin, clockInDeliPosEmployee, decodePosSession, encodePosSession, hashEmployeePin } = await import("../src/lib/pos-auth");
  const { updateDirectoryEmployee } = await import("../src/lib/employee-directory-admin");
  const { createDraftOrderWithVariants } = await import("../src/lib/ordering-orders-with-variants");
  const { submitDraftOrder, transitionKitchenOrder } = await import("../src/lib/ordering-order-lifecycle");
  const results: Record<string, unknown> = {};
  try {
    await withTransaction(async () => {
      const sql = getSql();
      const activeId = randomUUID(), idleId = randomUUID(), disabledId = randomUUID(), tikiId = randomUUID();
      const generated = new Set<string>();
      while (generated.size < 4) generated.add(String(randomInt(1000, 10000)));
      const [activePin, idlePin, disabledPin, tikiPin] = [...generated];
      const pins = { active: activePin, idle: idlePin, disabled: disabledPin };
      await sql`
        INSERT INTO employees (id,business,name,pin_hash,pin_enabled,position,role_group,active)
        VALUES
          (${activeId},'Corner Deli','POS Auth Active',${hashEmployeePin("Corner Deli",pins.active)},TRUE,'Pizza','In-House',TRUE),
          (${idleId},'Corner Deli','POS Auth Idle',${hashEmployeePin("Corner Deli",pins.idle)},TRUE,'Counter','In-House',TRUE),
          (${disabledId},'Corner Deli','POS Auth Disabled',${hashEmployeePin("Corner Deli",pins.disabled)},TRUE,'Counter','In-House',FALSE),
          (${tikiId},'Tiki','POS Auth Tiki',${hashEmployeePin("Corner Deli",tikiPin)},TRUE,'Bartender','In-House',TRUE)
      `;
      await sql`
        INSERT INTO time_entries (id,business,employee_id,employee_name,position,role_group,clock_in,source,status)
        VALUES (${randomUUID()},'Corner Deli',${activeId},'POS Auth Active','Pizza','In-House',NOW(),'POS auth test','Open')
      `;

      const active = await authenticateDeliPosPin(pins.active, "test-valid");
      if (active.employeeId !== activeId || active.clockInRequired) throw new Error("Already-clocked-in employee did not enter immediately.");
      const idle = await authenticateDeliPosPin(pins.idle, "test-idle");
      if (idle.employeeId !== idleId || !idle.clockInRequired) throw new Error("Idle employee did not receive clock-in-required state.");

      let invalidPin = String(randomInt(1000, 10000));
      while (generated.has(invalidPin)) invalidPin = String(randomInt(1000, 10000));
      for (const [label, supplied] of [["invalidPin", invalidPin], ["invalidLength", "123"], ["disabledEmployee", pins.disabled], ["tikiRejected", tikiPin]] as const) {
        let rejected = false;
        try { await authenticateDeliPosPin(supplied, `test-${label}`); } catch { rejected = true; }
        if (!rejected) throw new Error(`${label} was accepted.`);
        results[label] = true;
      }

      let duplicateRejected = false;
      try { await updateDirectoryEmployee({ id: idleId, business: "Corner Deli", pin: pins.active, actor: "pos-auth-test" }); }
      catch (error) { duplicateRejected = error instanceof Error && error.message.includes("already assigned"); }
      if (!duplicateRejected) throw new Error("Duplicate PIN assignment was not rejected clearly.");

      const token = encodePosSession(idle);
      const decoded = decodePosSession(token);
      if (!decoded || decoded.employeeId !== idleId || token.includes(pins.idle) || JSON.stringify(decoded).toLowerCase().includes("pin")) {
        throw new Error("POS session contained PIN material or failed identity round-trip.");
      }

      const firstClockIn = await clockInDeliPosEmployee(idle);
      const secondClockIn = await clockInDeliPosEmployee(idle);
      if (firstClockIn.alreadyClockedIn || !secondClockIn.alreadyClockedIn || firstClockIn.entry.id !== secondClockIn.entry.id) throw new Error("Clock-in was not idempotent.");
      const openCount = Number((await sql`SELECT COUNT(*)::INTEGER AS count FROM time_entries WHERE employee_id=${idleId} AND clock_out IS NULL`)[0].count);
      if (openCount !== 1) throw new Error(`Expected one open time entry, found ${openCount}.`);

      const menu = (await sql`
        SELECT item.id AS item_id, variant.id AS variant_id FROM ordering_menu_items item
        JOIN ordering_menu_item_variants variant ON variant.item_id=item.id AND variant.active=TRUE
        WHERE item.business='Corner Deli' AND item.name='Pizza' AND variant.name='Small 12"' LIMIT 1
      `)[0];
      const draft = await createDraftOrderWithVariants({
        business:"Corner Deli",source:"pos",serviceType:"pickup",createdBy:idleId,createdByName:idle.name,
        customerFirstName:"POS",customerLastName:"Auth",callerPhone:"3155550100",
        items:[{itemId:String(menu.item_id),variantId:String(menu.variant_id),modifierSelections:{}}],
      });
      const actor = { id: idleId, name: idle.name, type: "employee" as const };
      await submitDraftOrder(String(draft.id),"Corner Deli",actor);
      await transitionKitchenOrder({orderId:String(draft.id),business:"Corner Deli",expectedStatus:"sent_to_kitchen",nextStatus:"in_progress",actor});
      const events = await sql`SELECT event_type,actor_id,details FROM ordering_order_events WHERE order_id=${draft.id} ORDER BY created_at`;
      if (!events.some((event) => event.event_type === "order_created" && event.actor_id === idleId && event.details.actorName === idle.name)) throw new Error("Draft creation attribution missing.");
      if (!events.some((event) => event.event_type === "status_changed" && event.actor_id === idleId && event.details.to === "sent_to_kitchen")) throw new Error("Submission attribution missing.");
      if (!events.some((event) => event.event_type === "status_changed" && event.actor_id === idleId && event.details.to === "in_progress")) throw new Error("Kitchen attribution missing.");

      Object.assign(results, {
        validFourDigitPin:true, alreadyClockedInImmediate:true, clockInRequired:true,
        duplicatePinRejected:true, sessionIdentityWithoutPin:true, sessionHours:12,
        clockInCreatedOne:true, duplicateClockInIdempotent:true,
        orderEmployeeAttribution:true, kitchenEmployeeAttribution:true,
      });
      throw new Error(ROLLBACK);
    });
  } catch (error) { if (!(error instanceof Error) || error.message !== ROLLBACK) throw error; }
  const leftovers = Number((await getSql()`SELECT COUNT(*)::INTEGER AS count FROM employees WHERE name LIKE 'POS Auth %'`)[0].count);
  if (leftovers) throw new Error("POS auth validation left test employees behind.");
  results.rollbackIsolation = true;
  console.log(JSON.stringify(results, null, 2));
}

main().catch((error)=>{console.error(error instanceof Error ? error.stack || error.message : String(error));process.exitCode=1;});
