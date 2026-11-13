import { getSql } from "@/lib/db";
import { ensureCustomerOrderingSchema } from "@/lib/customer-ordering-schema";
import { sendTransactionalEmail } from "@/lib/transactional-email";
import { orderReceiptBreakdown } from "@/lib/ordering-sales-tax";
import { receiptBreakdownRows } from "@/lib/receipt-tax";
import { waitingForOpening } from "@/lib/customer-order-progress";
import { deliveryFeeWaiverFor } from "@/lib/ordering-delivery-core";

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export async function customerOrderConfirmation(orderId: string): Promise<any> {
  await ensureCustomerOrderingSchema();
  const sql = getSql();
  const order = (
    await sql`
    SELECT id,display_number,status,payment_status,service_type,timing_mode,
      scheduled_for,promised_at,quoted_lead_max_minutes,timing_message_snapshot,first_name_snapshot,last_name_snapshot,
      phone_snapshot,email_snapshot,subtotal_cents,discount_cents,tax_cents,
      tip_cents,delivery_fee_cents,total_cents,paid_cents,amount_due_cents,voided_at,
      kitchen_release_at,COALESCE(status='sent_to_kitchen' AND kitchen_release_at>NOW(),FALSE) held_until_prep,
      created_at,confirmation_email_sent_at,
      (SELECT COALESCE(SUM(payment.amount_cents),0)::int FROM ordering_payment_transactions payment
        WHERE payment.order_id=ordering_orders.id AND payment.transaction_type IN ('void','refund') AND payment.status='approved') refunded_cents
    FROM ordering_orders WHERE id=${orderId} AND business='Corner Deli' AND source='web' LIMIT 1
  `
  )[0] as Record<string, any> | undefined;
  if (!order) return null;
  const lines = (await sql`
    SELECT item_name_snapshot name,variant_name_snapshot variant_name,quantity,
      line_total_cents,special_instructions
    FROM ordering_order_items WHERE order_id=${orderId} ORDER BY sort_order,created_at,id
  `) as Array<Record<string, any>>;
  const receipt = await orderReceiptBreakdown(orderId);
  const address = (await sql`SELECT line1,postal_code,formatted_address FROM ordering_order_delivery_addresses WHERE order_id=${orderId}`)[0];
  const feeWaiver = String(order.service_type).includes("delivery") && Number(order.delivery_fee_cents) === 0
    ? deliveryFeeWaiverFor({ line1: address?.line1, postalCode: address?.postal_code, formattedAddress: address?.formatted_address })
    : null;
  return {
    ...order,
    waiting_for_open: waitingForOpening({
      status: String(order.status), timing_mode: order.timing_mode,
      promised_at: order.promised_at, quoted_lead_max_minutes: order.quoted_lead_max_minutes,
    }),
    receipt,
    receipt_rows: receiptBreakdownRows(receipt),
    delivery_fee_waiver_label: feeWaiver?.label || "",
    sales_tax_included_cents: receipt.taxCents,
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
    amount_due_cents: Number(order.amount_due_cents),
    refunded_cents: Number(order.refunded_cents),
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
  const delivery = ["delivery", "no_contact_delivery"].includes(String(order.service_type));
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
      `${delivery ? "Delivery" : "Pickup"}: ${order.timing_message_snapshot || (delivery ? "Delivery" : "Pickup")}`,
      "",
      ...details,
      "",
      ...(order.discount_cents
        ? [`Discount: -${money(order.discount_cents)}`]
        : []),
      ...(Number(order.delivery_fee_cents) > 0 && !order.receipt.untaxedFeeCents
        ? [`Delivery fee: ${money(Number(order.delivery_fee_cents))}`]
        : []),
      ...(order.delivery_fee_waiver_label ? [order.delivery_fee_waiver_label] : []),
      "",
      ...order.receipt_rows.map(([label, amount]: [string, string]) => `${label}: ${amount}`),
      order.payment_status === "paid"
        ? `Paid: ${money(order.paid_cents)}`
        : `Due at ${delivery ? "delivery" : "pickup"}: ${money(Math.max(0, order.total_cents - order.paid_cents))}`,
      "",
      "All sales final: Once an order is placed, it cannot be cancelled and no refunds are given.",
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
