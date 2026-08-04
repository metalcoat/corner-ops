import { getSql } from "@/lib/db";
import { payrollSummary } from "@/lib/payroll-summary-rules";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WEEK_START = "2026-07-27";
const START = "2026-07-27T08:00:00.000Z";
const END = "2026-08-03T08:00:00.000Z";

function normalize(value: unknown) {
  return String(value ?? "")
    .trim()
    .replace(/^['\"]+|['\"]+$/g, "")
    .replace(/\.0+$/, "")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
}

export async function GET() {
  const sql = getSql();
  const [summary, orderRows, transactionRows, shiftRows] = await Promise.all([
    payrollSummary("Corner Deli", WEEK_START),
    sql`
      SELECT order_id, order_type, opened_at
      FROM rezku_orders
      WHERE opened_at >= ${START} AND opened_at < ${END}
      ORDER BY opened_at
    `,
    sql`
      SELECT transaction_id, order_id, transaction_time, tip
      FROM rezku_transactions
      WHERE transaction_time >= ${START} AND transaction_time < ${END} AND tip <> 0
      ORDER BY transaction_time
    `,
    sql`
      SELECT employee_name, position, role_group, clock_in, clock_out
      FROM rezku_shifts
      WHERE clock_in >= ${START} AND clock_in < ${END}
      ORDER BY clock_in
    `,
  ]);

  const orders = orderRows as unknown as Array<Record<string, unknown>>;
  const transactions = transactionRows as unknown as Array<Record<string, unknown>>;
  const shifts = shiftRows as unknown as Array<Record<string, unknown>>;
  const byId = new Map(orders.map((row) => [normalize(row.order_id), String(row.order_type || "")]));
  const classifications = transactions.map((row) => {
    const key = normalize(row.order_id);
    const orderType = byId.get(key) || "";
    return {
      transactionId: row.transaction_id,
      orderId: row.order_id,
      transactionTime: row.transaction_time,
      tip: Number(row.tip || 0),
      matched: Boolean(key && byId.has(key)),
      orderType,
      delivery: /deliver/i.test(orderType),
      pickup: /pick\s*up|pickup|take\s*out|takeout|carry\s*out|carryout|to\s*go|togo|counter/i.test(orderType),
    };
  });

  const aggregate = classifications.reduce((result, row) => {
    result.tipTotal += row.tip;
    if (!row.matched) {
      result.unmatchedCount += 1;
      result.unmatchedTips += row.tip;
    } else if (row.delivery) {
      result.deliveryCount += 1;
      result.deliveryTips += row.tip;
    } else if (row.pickup) {
      result.pickupCount += 1;
      result.pickupTips += row.tip;
    } else {
      result.unknownCount += 1;
      result.unknownTips += row.tip;
    }
    return result;
  }, {
    tipTotal: 0,
    deliveryCount: 0,
    deliveryTips: 0,
    pickupCount: 0,
    pickupTips: 0,
    unmatchedCount: 0,
    unmatchedTips: 0,
    unknownCount: 0,
    unknownTips: 0,
  });

  return Response.json({
    weekStart: WEEK_START,
    aggregate,
    payrollRows: (summary as { rows?: unknown[] }).rows || [],
    unallocated: ((summary as { tipJoinIssues?: unknown[] }).tipJoinIssues || []),
    classifications,
    shifts,
  });
}
