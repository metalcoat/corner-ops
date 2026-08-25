import { randomUUID } from "node:crypto";
import { getSql, withTransaction } from "@/lib/db";
import { commitTender } from "@/lib/ordering-payments";
import {
  ensureDriverDeliverySchema,
  type DriverActor,
} from "@/lib/ordering-driver-delivery";

function manager(actor: DriverActor) {
  if (!actor.manager) throw new Error("Manager or owner access is required.");
}

export async function driverCashDashboard(actor: DriverActor) {
  manager(actor);
  await ensureDriverDeliverySchema();
  const sql = getSql();
  const [drivers, orders, settlements] = await Promise.all([
    sql`SELECT id,name FROM employees WHERE business=${actor.business} AND active=TRUE AND role_group='Driver' ORDER BY name`,
    sql`SELECT o.id order_id,o.display_number,o.amount_due_cents,o.total_cents,d.driver_employee_id,d.delivered_at,COALESCE(NULLIF(trim(o.first_name_snapshot||' '||o.last_name_snapshot),''),'Guest') customer_name FROM ordering_delivery_assignments d JOIN ordering_orders o ON o.id=d.order_id WHERE d.business=${actor.business} AND d.status='DELIVERED' AND d.driver_employee_id IS NOT NULL AND o.amount_due_cents>0 AND NOT EXISTS(SELECT 1 FROM ordering_driver_cash_settlement_orders so JOIN ordering_driver_cash_settlements s ON s.id=so.settlement_id WHERE so.order_id=o.id AND s.status='posted') ORDER BY d.delivered_at,o.display_number`,
    sql`SELECT s.id,s.business_date,s.order_count,s.expected_cash_cents,s.turned_in_cash_cents,s.over_short_cents,s.posted_at,e.name driver_name FROM ordering_driver_cash_settlements s JOIN employees e ON e.id=s.driver_employee_id WHERE s.business=${actor.business} AND s.status='posted' ORDER BY s.posted_at DESC LIMIT 30`,
  ]);
  return { drivers, orders, settlements };
}

export async function postDriverCashSettlement(
  actor: DriverActor,
  input: {
    driverId: string;
    orderIds: string[];
    turnedInCashCents: number;
    businessDate: string;
  },
) {
  manager(actor);
  await ensureDriverDeliverySchema();
  const orderIds = [...new Set(input.orderIds.map(String))];
  if (!orderIds.length) throw new Error("Select at least one delivered order.");
  if (
    !Number.isSafeInteger(input.turnedInCashCents) ||
    input.turnedInCashCents < 0
  )
    throw new Error("Enter a valid cash amount turned in.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.businessDate))
    throw new Error("Choose a valid business date.");
  return withTransaction(async () => {
    const sql = getSql();
    const driver = (
      await sql`SELECT id,name FROM employees WHERE id=${input.driverId} AND business=${actor.business} AND active=TRUE AND role_group='Driver' FOR UPDATE`
    )[0];
    if (!driver) throw new Error("Choose an active driver.");
    const orders =
      await sql`SELECT o.id,o.display_number,o.amount_due_cents FROM ordering_delivery_assignments d JOIN ordering_orders o ON o.id=d.order_id WHERE d.business=${actor.business} AND d.driver_employee_id=${input.driverId} AND d.status='DELIVERED' AND o.id=ANY(${orderIds}::uuid[]) AND o.amount_due_cents>0 AND NOT EXISTS(SELECT 1 FROM ordering_driver_cash_settlement_orders so JOIN ordering_driver_cash_settlements s ON s.id=so.settlement_id WHERE so.order_id=o.id AND s.status='posted') FOR UPDATE OF o,d`;
    if (orders.length !== orderIds.length)
      throw new Error(
        "One or more orders are no longer eligible. Refresh and review the cash-out.",
      );
    const expected = orders.reduce(
      (sum, order) => sum + Number(order.amount_due_cents),
      0,
    );
    const settlementId = randomUUID();
    await sql`INSERT INTO ordering_driver_cash_settlements(id,business,driver_employee_id,business_date,status,order_count,expected_cash_cents,turned_in_cash_cents,over_short_cents,created_by,approved_by,posted_at) VALUES(${settlementId},${actor.business},${input.driverId},${input.businessDate},'posted',${orders.length},${expected},${input.turnedInCashCents},${input.turnedInCashCents - expected},${actor.employeeId},${actor.employeeId},NOW())`;
    for (const order of orders) {
      const mutationId = `driver-settlement:${settlementId}:${order.id}`;
      await commitTender({
        orderId: String(order.id),
        business: actor.business,
        tenderType: "cash",
        amountTenderedCents: Number(order.amount_due_cents),
        clientMutationId: mutationId,
        cashControlMode: "driver_settlement",
        actor: {
          id: actor.employeeId,
          name: actor.name,
          type: "employee",
          role: "manager",
        },
      });
      const payment = (
        await sql`SELECT id FROM ordering_payment_transactions WHERE business=${actor.business} AND client_mutation_id=${mutationId}`
      )[0];
      await sql`INSERT INTO ordering_driver_cash_settlement_orders(id,settlement_id,order_id,amount_due_cents,cash_payment_transaction_id) VALUES(${randomUUID()},${settlementId},${order.id},${Number(order.amount_due_cents)},${payment.id})`;
    }
    return {
      id: settlementId,
      driverName: String(driver.name),
      orderCount: orders.length,
      expectedCashCents: expected,
      turnedInCashCents: input.turnedInCashCents,
      overShortCents: input.turnedInCashCents - expected,
    };
  });
}
