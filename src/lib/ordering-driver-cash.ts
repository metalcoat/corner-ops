import { randomUUID } from "node:crypto";
import { getSql, withTransaction } from "@/lib/db";
import { commitTender } from "@/lib/ordering-payments";
import {
  ensureDriverDeliverySchema,
  type DriverActor,
} from "@/lib/ordering-driver-delivery";
import { driverSettlementError } from "@/lib/ordering-payment-rules";

/** The back drawer's till (`ordering_pos_terminals.terminal_key`); driver cash is turned in there. */
const BACK_TILL_KEY = "back-register";

export async function driverCashDashboard(actor: DriverActor) {
  if (!actor.manager && !actor.driver) throw new Error("Driver or manager access is required for cash-out.");
  await ensureDriverDeliverySchema();
  const sql = getSql();
  const [orders, settlements] = await Promise.all([
    sql`SELECT o.id order_id,o.display_number,o.amount_due_cents,o.total_cents,o.completed_at,dispatch.driver_employee_id,driver.name driver_name,dispatch.status delivery_status,COALESCE(dispatch.picked_up_at,dispatch.en_route_at) taken_at,dispatch.delivered_at,COALESCE(NULLIF(trim(o.first_name_snapshot||' '||o.last_name_snapshot),''),'Guest') customer_name,COALESCE(address.formatted_address,address.line1,'') delivery_address,COALESCE(address.line2,'') delivery_unit FROM ordering_orders o LEFT JOIN LATERAL(SELECT d.driver_employee_id,d.status,d.picked_up_at,d.en_route_at,d.delivered_at FROM ordering_delivery_assignments d WHERE d.order_id=o.id AND d.business=o.business ORDER BY d.updated_at DESC,d.created_at DESC LIMIT 1)dispatch ON TRUE LEFT JOIN employees driver ON driver.id=dispatch.driver_employee_id LEFT JOIN ordering_order_delivery_addresses address ON address.order_id=o.id WHERE o.business=${actor.business} AND o.service_type='delivery' AND o.status IN('confirmed','sent_to_kitchen','in_progress','ready','completed') AND (o.timing_mode<>'future' OR o.scheduled_for<=NOW()) AND o.amount_due_cents>0 AND (dispatch.status IN('PICKED_UP','EN_ROUTE','ARRIVED','NO_CONTACT','DELIVERED') OR (o.status='completed' AND COALESCE(dispatch.status,'') NOT IN('DELIVERY_FAILED','RETURNED','CANCELLED'))) AND (${actor.manager} OR dispatch.driver_employee_id=${actor.employeeId}) AND NOT EXISTS(SELECT 1 FROM ordering_driver_cash_settlement_orders so JOIN ordering_driver_cash_settlements s ON s.id=so.settlement_id WHERE so.order_id=o.id AND s.status='posted') ORDER BY COALESCE(dispatch.delivered_at,dispatch.picked_up_at,o.completed_at,o.ready_at,o.submitted_at,o.created_at),o.display_number`,
    sql`SELECT s.id,s.business_date,s.order_count,s.expected_cash_cents,s.turned_in_cash_cents,s.over_short_cents,s.posted_at,s.notes,COALESCE(handler.name,'') handled_by_name,COALESCE((SELECT string_agg(DISTINCT e.name,', ') FROM ordering_driver_cash_settlement_orders so JOIN employees e ON e.id=so.driver_employee_id WHERE so.settlement_id=s.id),'') driver_names FROM ordering_driver_cash_settlements s LEFT JOIN employees handler ON handler.id::text=s.created_by WHERE s.business=${actor.business} AND s.status='posted' ORDER BY s.posted_at DESC LIMIT 30`,
  ]);
  return { orders, settlements, handledBy: actor.name };
}

export async function postDriverCashSettlement(
  actor: DriverActor,
  input: {
    orderIds: string[];
    turnedInCashCents: number;
    businessDate: string;
    shortReason?: string;
  },
) {
  await ensureDriverDeliverySchema();
  const orderIds = [...new Set(input.orderIds.map(String))];
  if (!orderIds.length) throw new Error("Select at least one delivery order.");
  if (
    !Number.isSafeInteger(input.turnedInCashCents) ||
    input.turnedInCashCents < 0
  )
    throw new Error("Enter a valid cash amount turned in.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.businessDate))
    throw new Error("Choose a valid business date.");
  const accessError = driverSettlementError({ isDriver: actor.driver, isManager: actor.manager, expectedCents: 0, turnedInCents: 0, unassignedOrderCount: 0 });
  if (accessError) throw new Error(accessError);
  return withTransaction(async () => {
    const sql = getSql();
    const orders =
      await sql`SELECT o.id,o.display_number,o.amount_due_cents,dispatch.driver_employee_id FROM ordering_orders o LEFT JOIN LATERAL(SELECT d.driver_employee_id,d.status FROM ordering_delivery_assignments d WHERE d.order_id=o.id AND d.business=o.business ORDER BY d.updated_at DESC,d.created_at DESC LIMIT 1)dispatch ON TRUE WHERE o.business=${actor.business} AND o.service_type='delivery' AND o.status IN('confirmed','sent_to_kitchen','in_progress','ready','completed') AND (o.timing_mode<>'future' OR o.scheduled_for<=NOW()) AND o.id=ANY(${orderIds}::uuid[]) AND o.amount_due_cents>0 AND (dispatch.status IN('PICKED_UP','EN_ROUTE','ARRIVED','NO_CONTACT','DELIVERED') OR (o.status='completed' AND COALESCE(dispatch.status,'') NOT IN('DELIVERY_FAILED','RETURNED','CANCELLED'))) AND NOT EXISTS(SELECT 1 FROM ordering_driver_cash_settlement_orders so JOIN ordering_driver_cash_settlements s ON s.id=so.settlement_id WHERE so.order_id=o.id AND s.status='posted') FOR UPDATE OF o`;
    if (orders.length !== orderIds.length)
      throw new Error(
        "One or more orders are no longer eligible (still in the store, already paid, or already cashed out). Refresh and review the cash-out.",
      );
    const expected = orders.reduce(
      (sum, order) => sum + Number(order.amount_due_cents),
      0,
    );
    const settlementError = driverSettlementError({
      isDriver: actor.driver,
      isManager: actor.manager,
      expectedCents: expected,
      turnedInCents: input.turnedInCashCents,
      unassignedOrderCount: orders.filter((order) => String(order.driver_employee_id || "") !== actor.employeeId).length,
    });
    if (settlementError) throw new Error(settlementError);
    const shortReason = String(input.shortReason || "").trim().slice(0, 500);
    if (input.turnedInCashCents < expected && !shortReason)
      throw new Error("Enter a reason for the short cash before posting.");
    // Driver cash goes in the back drawer: the back till's expected cash rises by what stays in it
    // (anything over the orders' total is handed back to the driver).
    const backTill = (
      await sql`SELECT id FROM ordering_pos_terminals WHERE business=${actor.business} AND terminal_key=${BACK_TILL_KEY} AND active=TRUE`
    )[0];
    let register: Record<string, unknown> | undefined;
    if (backTill) {
      register = (
        await sql`SELECT id,status FROM ordering_register_sessions WHERE terminal_id=${backTill.id} AND status IN ('open','counting','needs_review','resetting') ORDER BY opened_at DESC LIMIT 1 FOR UPDATE`
      )[0];
      if (register?.status !== "open")
        throw new Error("Open the back till before cashing out drivers. Driver cash goes in the back drawer.");
    }
    const drivers = [...new Set(orders.map((order) => String(order.driver_employee_id || "")))];
    const settlementDriver = drivers.length === 1 && drivers[0] ? drivers[0] : actor.employeeId;
    const settlementId = randomUUID();
    await sql`INSERT INTO ordering_driver_cash_settlements(id,business,driver_employee_id,register_session_id,business_date,status,order_count,expected_cash_cents,turned_in_cash_cents,over_short_cents,created_by,approved_by,posted_at,notes) VALUES(${settlementId},${actor.business},${settlementDriver},${register ? String(register.id) : null},${input.businessDate},'posted',${orders.length},${expected},${input.turnedInCashCents},${input.turnedInCashCents - expected},${actor.employeeId},${actor.employeeId},NOW(),${shortReason})`;
    const drawerCents = Math.min(input.turnedInCashCents, expected);
    if (register && drawerCents > 0) {
      await sql`INSERT INTO ordering_cash_drawer_movements(id,register_session_id,movement_type,delta_cash_cents,reason,employee_id,created_by,details) VALUES(${randomUUID()},${register.id},'driver_turn_in',${drawerCents},'Driver cash turned in',${actor.employeeId},${actor.employeeId},${JSON.stringify({ settlementId, orderCount: orders.length, expectedCashCents: expected, turnedInCashCents: input.turnedInCashCents })}::jsonb)`;
      await sql`UPDATE ordering_register_sessions SET expected_cash_cents=expected_cash_cents+${drawerCents} WHERE id=${register.id}`;
    }
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
          role: actor.manager ? "manager" : "employee",
        },
      });
      const payment = (
        await sql`SELECT id FROM ordering_payment_transactions WHERE business=${actor.business} AND client_mutation_id=${mutationId}`
      )[0];
      await sql`INSERT INTO ordering_driver_cash_settlement_orders(id,settlement_id,order_id,amount_due_cents,cash_payment_transaction_id,driver_employee_id) VALUES(${randomUUID()},${settlementId},${order.id},${Number(order.amount_due_cents)},${payment.id},${order.driver_employee_id || null})`;
    }
    return {
      id: settlementId,
      handledByName: actor.name,
      orderCount: orders.length,
      expectedCashCents: expected,
      turnedInCashCents: input.turnedInCashCents,
      overShortCents: input.turnedInCashCents - expected,
      backDrawerCents: register ? drawerCents : 0,
    };
  });
}
