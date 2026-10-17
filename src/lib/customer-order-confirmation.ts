import { getSql } from "@/lib/db";
import { ensureCustomerOrderingSchema } from "@/lib/customer-ordering-schema";
import { sendTransactionalEmail } from "@/lib/transactional-email";

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export async function customerOrderConfirmation(orderId: string): Promise<any> {
  await ensureCustomerOrderingSchema();
  const sql = getSql();
  const order = (
    await sql`
    SELECT id,display_number,status,payment_status,service_type,timing_mode,
      scheduled_for,timing_message_snapshot,first_name_snapshot,last_name_snapshot,
      phone_snapshot,email_snapshot,subtotal_cents,discount_cents,tax_cents,
      tip_cents,total_cents,paid_cents,created_at,confirmation_email_sent_at
    FROM ordering_orders WHERE id=${orderId} AND business='Corner Deli' AND source='web' LIMIT 1
  `
  )[0] as Record<string, any> | undefined;
  if (!order) return null;
  const lines = (await sql`
    SELECT item_name_snapshot name,variant_name_snapshot variant_name,quantity,
      line_total_cents,special_instructions
    FROM ordering_order_items WHERE order_id=${orderId} ORDER BY sort_order,created_at,id
  `) as Array<Record<string, any>>;
  return {
    ...order,
    email_delivery_configured: Boolean(
      (process.env.RESEND_API_KEY?.trim() &&
        (process.env.EMPLOYEE_NOTIFICATION_FROM_EMAIL?.trim() ||
          process.env.ALERT_FROM_EMAIL?.trim())) ||
      (process.env.SMTP_USER?.trim() && process.env.SMTP_PASSWORD?.trim()),
    ),
    subtotal_cents: Number(order.subtotal_cents),
    discount_cents: Number(order.discount_cents),
    tax_cents: Number(order.tax_cents),
    tip_cents: Number(order.tip_cents),
    total_cents: Number(order.total_cents),
    paid_cents: Number(order.paid_cents),
    lines: lines.map((line) => ({
      ...line,
      quantity: Number(line.quantity),
      line_total_cents: Number(line.line_total_cents),
    })),
  };
}

export async function sendCustomerOrderConfirmation(orderId: string) {
  const order = await customerOrderConfirmation(orderId);
  if (!order || order.confirmation_email_sent_at || order.status === "draft")
    return { configured: true, sent: 0, failures: [] };
  const name =
    `${order.first_name_snapshot} ${order.last_name_snapshot}`.trim();
  const details = order.lines.map(
    (line: Record<string, any>) =>
      `${line.quantity}× ${line.variant_name ? `${line.variant_name} ` : ""}${line.name} — ${money(line.line_total_cents)}${line.special_instructions ? `\n   Note: ${line.special_instructions}` : ""}`,
  );
  const result = await sendTransactionalEmail({
    to: String(order.email_snapshot),
    subject: `Corner Deli order #${order.display_number} confirmed`,
    idempotencyKey: `corner-deli-order-confirmation-${order.id}`,
    text: [
      `Thanks${name ? `, ${name}` : ""}! Your Corner Deli order is confirmed.`,
      "",
      `Order #${order.display_number}`,
      `Pickup: ${order.timing_message_snapshot || "Pickup"}`,
      "",
      ...details,
      "",
      ...(order.discount_cents
        ? [`Discount: -${money(order.discount_cents)}`]
        : []),
      order.payment_status === "paid"
        ? `Total paid: ${money(order.paid_cents)}`
        : `Total due at pickup: ${money(order.total_cents)}`,
      "",
      "No-cancellation policy: Once an order is submitted and sent to Corner Deli, it cannot be cancelled.",
      "",
      "Corner Deli",
    ].join("\n"),
  });
  const sql = getSql();
  if (result.sent > 0) {
    await sql`UPDATE ordering_orders SET confirmation_email_sent_at=NOW(),confirmation_email_error='' WHERE id=${orderId}`;
  } else {
    await sql`UPDATE ordering_orders SET confirmation_email_error=${result.failures.join("; ").slice(0, 1000)} WHERE id=${orderId}`;
  }
  return result;
}
