import { randomUUID } from "node:crypto";
import { localValidationEnv } from "./validation-env";
localValidationEnv();

void (async () => {
  const { ensureOrderingCustomerSchema } = await import("../src/lib/ordering-customer-schema");
  const { getSql } = await import("../src/lib/db");
  const { businessDate, listOrders } = await import("../src/lib/ordering-order-center");
  await ensureOrderingCustomerSchema();
  const sql = getSql();
  const ids: string[] = [];
  try {
    const today = businessDate();
    const fixtures = [
      ["pickup", "unpaid", "sent_to_kitchen", 0], ["delivery", "unpaid", "ready", 0],
      ["pickup", "unpaid", "draft", 0], ["pickup", "paid", "completed", 0],
      ["delivery", "paid", "completed", 0], ["pickup", "unpaid", "completed", 0],
      ["pickup", "unpaid", "ready", -1], ["pickup", "paid", "completed", -1],
    ] as const;
    for (let index = 0; index < fixtures.length; index += 1) {
      const id = randomUUID(); ids.push(id);
      const [service, payment, status, offset] = fixtures[index];
      const created = new Date(`${today}T16:00:00-04:00`); created.setUTCDate(created.getUTCDate() + offset); created.setUTCSeconds(index);
      const scheduled = index === 2 ? new Date(created.getTime() + 86_400_000 + 5_400_000) : null;
      await sql`INSERT INTO ordering_orders(id,business,source,status,payment_status,service_type,total_cents,amount_due_cents,display_number,created_by,first_name_snapshot,last_name_snapshot,phone_snapshot,order_origin,created_at,scheduled_for) VALUES(${id},'Corner Deli','pos',${status},${payment},${service},2375,${payment === "paid" ? 0 : 2375},${`V${index + 1}`},'validation','Sarah','Smith','+13155551212','phone',${created.toISOString()},${scheduled?.toISOString() || null})`;
      if (service === "delivery") await sql`INSERT INTO ordering_order_delivery_addresses(order_id,entered_address,formatted_address,line1,city,state,postal_code,latitude,longitude,provider,validation_status,validated_at) VALUES(${id},'412 Jay St','412 Jay St, Utica, NY 13501','412 Jay St','Utica','NY','13501',43.1,-75.2,'validation','validated',NOW())`;
    }
    const todayRows = await listOrders({ business: "Corner Deli", date: today });
    const open = await listOrders({ business: "Corner Deli", allOpen: true });
    if (!todayRows.some((order) => order.delivery_address) || !todayRows.some((order) => order.scheduled_for)) throw new Error("Today address/future presentation data missing.");
    const overdue = todayRows.filter((order) => order.overdue_unpaid);
    if (!overdue.some((order) => order.display_number === "V7") || overdue.some((order) => order.display_number === "V8")) throw new Error("Today's overdue unpaid reminder semantics failed.");
    if (open.some((order) => ["paid", "refunded"].includes(order.payment_status)) || !open.some((order) => order.display_number === "V7")) throw new Error("All Open semantics failed.");
    const firstPaid = todayRows.findIndex((order) => order.payment_status === "paid");
    const lastUnpaid = todayRows.map((order) => order.payment_status).lastIndexOf("unpaid");
    if (firstPaid >= 0 && firstPaid < lastUnpaid) throw new Error("Paid sorting failed.");
    console.log(JSON.stringify({ todayFixtures: 6, yesterdayFixtures: 2, overdueUnpaidSurfacedToday: true, yesterdayPaidExcludedFromReminder: true, allOpenIncludesYesterday: true, paidSortedLower: true, deliveryAddress: true, futureTime: true }, null, 2));
  } finally { for (const id of ids.reverse()) await sql`DELETE FROM ordering_orders WHERE id=${id}`; }
  process.exit();
})().catch((error) => { console.error(error); process.exit(1); });
