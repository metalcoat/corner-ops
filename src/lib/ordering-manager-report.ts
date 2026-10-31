import { getSql } from "@/lib/db";
import { businessDayBoundary } from "@/lib/business-day";
import { businessDateOf, tillCloseoutsForDay } from "@/lib/ordering-registers";
import { listUnresolvedVoidMoney } from "@/lib/ordering-void-money";
import { computeCallStats } from "@/lib/three-cx-call-stats";

export type ManagerReportView = "day" | "week" | "month";
const LIST_LIMIT = 200;
const BUSINESS = "Corner Deli";

const shift = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** First and last business date of the day, Monday-to-Sunday week or calendar month holding `date`. */
export function managerReportRange(view: ManagerReportView, date: string) {
  if (view === "day") return { start: date, end: date };
  if (view === "week") {
    const start = shift(date, -((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7));
    return { start, end: shift(start, 6) };
  }
  const [year, month] = date.split("-").map(Number);
  return { start: `${date.slice(0, 7)}-01`, end: new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10) };
}

const dayOf = (at: Date) => businessDateOf(at);
const number = (value: unknown) => Number(value || 0);

/** Everything a manager checks on a day, a week or a month. Only counts days that have started. */
export async function managerReport(input: { view: ManagerReportView; date: string; now?: Date }) {
  const now = input.now || new Date(), today = businessDateOf(now);
  const range = managerReportRange(input.view, input.date);
  const days: string[] = [];
  for (let day = range.start; day <= range.end && day <= today; day = shift(day, 1)) days.push(day);
  const from = businessDayBoundary(range.start).toISOString(), to = businessDayBoundary(range.end, true).toISOString();
  const sql = getSql();
  const [orders, tenders, voidedOrders, voidedItems, refunds, credits] = await Promise.all([
    sql`SELECT ((created_at AT TIME ZONE 'America/New_York') - INTERVAL '4 hours')::date::text business_date,COUNT(*)::int orders,COALESCE(SUM(total_cents),0)::bigint sales_cents,COALESCE(SUM(tip_cents),0)::bigint tips_cents,COALESCE(SUM(delivery_fee_cents),0)::bigint delivery_fees_cents
      FROM ordering_orders WHERE business=${BUSINESS} AND created_at>=${from} AND created_at<${to} AND status NOT IN('draft','cancelled') GROUP BY 1`,
    sql`SELECT ((created_at AT TIME ZONE 'America/New_York') - INTERVAL '4 hours')::date::text business_date,tender_type,
        COALESCE(SUM(CASE WHEN transaction_type='payment' THEN amount_cents ELSE 0 END),0)::bigint paid_cents,
        COALESCE(SUM(CASE WHEN transaction_type IN('refund','void') THEN amount_cents ELSE 0 END),0)::bigint reversed_cents
      FROM ordering_payment_transactions WHERE business=${BUSINESS} AND status='approved' AND created_at>=${from} AND created_at<${to} GROUP BY 1,2`,
    sql`SELECT o.id,o.display_number,o.voided_at,o.void_reason,o.total_cents,COALESCE(e.name,NULLIF(o.voided_by,''),'Unknown') voided_by
      FROM ordering_orders o LEFT JOIN employees e ON e.id::text=o.voided_by
      WHERE o.business=${BUSINESS} AND o.voided_at>=${from} AND o.voided_at<${to} ORDER BY o.voided_at DESC LIMIT ${LIST_LIMIT}`,
    sql`SELECT c.id,c.created_at,c.quantity,c.reason,c.actor_name,c.refund_cents,c.merchandise_cents+c.tax_cents-c.discount_cents amount_cents,o.id order_id,o.display_number,i.item_name_snapshot
      FROM ordering_order_item_cancellations c JOIN ordering_orders o ON o.id=c.order_id JOIN ordering_order_items i ON i.id=c.order_item_id
      WHERE o.business=${BUSINESS} AND c.created_at>=${from} AND c.created_at<${to} ORDER BY c.created_at DESC LIMIT ${LIST_LIMIT}`,
    sql`SELECT t.id,t.created_at,t.tender_type,t.transaction_type,t.amount_cents,t.reason,o.id order_id,o.display_number,COALESCE(e.name,NULLIF(t.created_by,''),'Unknown') by_name
      FROM ordering_payment_transactions t LEFT JOIN ordering_orders o ON o.id=t.order_id LEFT JOIN employees e ON e.id::text=t.created_by
      WHERE t.business=${BUSINESS} AND t.status='approved' AND t.transaction_type IN('refund','void') AND t.tender_type<>'store_credit' AND t.created_at>=${from} AND t.created_at<${to} ORDER BY t.created_at DESC LIMIT ${LIST_LIMIT}`,
    sql`SELECT l.id,l.created_at,l.entry_type,l.delta_balance_cents,l.reason,o.id order_id,o.display_number,COALESCE(NULLIF(c.display_name,''),'Customer') customer_name,COALESCE(e.name,NULLIF(l.created_by,''),'Unknown') by_name
      FROM ordering_store_credit_ledger l LEFT JOIN ordering_orders o ON o.id=l.order_id LEFT JOIN ordering_customers c ON c.id=l.customer_id LEFT JOIN employees e ON e.id::text=l.created_by
      WHERE l.business=${BUSINESS} AND l.created_at>=${from} AND l.created_at<${to} ORDER BY l.created_at DESC LIMIT ${LIST_LIMIT}`,
  ]);
  const tills: Array<{ businessDate: string; name: string; closedBy: string; closedAt: string | null; countedCents: number | null; expectedCents: number | null; overShortCents: number | null; inProgress: boolean }> = [];
  for (const day of days) for (const till of await tillCloseoutsForDay(day)) {
    tills.push({ businessDate: day, name: till.label, closedBy: till.closeout?.closedBy || "", closedAt: till.closeout?.closedAt || null, countedCents: till.closeout?.countedCents ?? null, expectedCents: till.closeout?.expectedCents ?? null, overShortCents: till.closeout?.overShortCents ?? null, inProgress: !till.closeout && day === today });
  }
  const callsEnd = new Date(Math.min(now.getTime(), Date.parse(to)));
  const calls = days.length ? await computeCallStats(callsEnd, new Date(from)) : null;

  const creditIssued = (row: Record<string, unknown>) => number(row.delta_balance_cents) > 0;
  const byDay = days.map((businessDate) => {
    const sales = orders.find((row) => row.business_date === businessDate);
    const dayTenders = tenders.filter((row) => row.business_date === businessDate);
    const sum = (key: "paid_cents" | "reversed_cents", match: (tender: string) => boolean) => dayTenders.filter((row) => match(String(row.tender_type))).reduce((total, row) => total + number(row[key]), 0);
    const dayTills = tills.filter((row) => row.businessDate === businessDate);
    const dayCredits = credits.filter((row) => dayOf(new Date(row.created_at)) === businessDate);
    return {
      businessDate,
      orders: number(sales?.orders), salesCents: number(sales?.sales_cents), tipsCents: number(sales?.tips_cents), deliveryFeesCents: number(sales?.delivery_fees_cents),
      cashCents: sum("paid_cents", (tender) => tender === "cash"), cardCents: sum("paid_cents", (tender) => tender === "card"), otherTenderCents: sum("paid_cents", (tender) => tender !== "cash" && tender !== "card"),
      refundedCents: sum("reversed_cents", (tender) => tender !== "store_credit"),
      creditIssuedCents: dayCredits.filter(creditIssued).reduce((total, row) => total + number(row.delta_balance_cents), 0),
      creditUsedCents: dayCredits.filter((row) => !creditIssued(row)).reduce((total, row) => total - number(row.delta_balance_cents), 0),
      voidCount: voidedOrders.filter((row) => dayOf(new Date(row.voided_at)) === businessDate).length + voidedItems.filter((row) => dayOf(new Date(row.created_at)) === businessDate).length,
      missedCalls: (calls?.missedCalls || []).filter((call) => dayOf(new Date(call.at)) === businessDate).length,
      overShortCents: dayTills.reduce((total, row) => total + number(row.overShortCents), 0),
      tillsMissing: dayTills.filter((row) => row.closedAt === null && !row.inProgress).length,
    };
  });
  const total = (key: keyof (typeof byDay)[number]) => byDay.reduce((sum, row) => sum + number(row[key]), 0);
  return {
    view: input.view, date: input.date, today, start: range.start, end: range.end,
    totals: Object.fromEntries((["orders", "salesCents", "tipsCents", "deliveryFeesCents", "cashCents", "cardCents", "otherTenderCents", "refundedCents", "creditIssuedCents", "creditUsedCents", "voidCount", "missedCalls", "overShortCents", "tillsMissing"] as const).map((key) => [key, total(key)])) as Record<string, number>,
    byDay,
    tills: tills.reverse(),
    calls: { hasData: Boolean(calls?.dataAsOf), total: calls?.total || 0, answered: calls?.answered || 0, missed: calls?.missed || 0, notCalledBack: calls?.missedNotCalledBack || 0, list: (calls?.missedCalls || []).slice(0, LIST_LIMIT) },
    voidedOrders: voidedOrders.map((row) => ({ id: String(row.id), number: String(row.display_number), at: new Date(row.voided_at).toISOString(), reason: String(row.void_reason || ""), by: String(row.voided_by), amountCents: number(row.total_cents) })),
    voidedItems: voidedItems.map((row) => ({ id: String(row.id), orderId: String(row.order_id), number: String(row.display_number), at: new Date(row.created_at).toISOString(), item: `${number(row.quantity)}× ${String(row.item_name_snapshot)}`, reason: String(row.reason || ""), by: String(row.actor_name || "Unknown"), amountCents: number(row.amount_cents) })),
    refunds: refunds.map((row) => ({ id: String(row.id), orderId: String(row.order_id || ""), number: String(row.display_number || ""), at: new Date(row.created_at).toISOString(), tender: String(row.tender_type), kind: String(row.transaction_type), reason: String(row.reason || ""), by: String(row.by_name), amountCents: number(row.amount_cents) })),
    credits: credits.map((row) => ({ id: String(row.id), orderId: String(row.order_id || ""), number: String(row.display_number || ""), at: new Date(row.created_at).toISOString(), customer: String(row.customer_name), kind: String(row.entry_type), reason: String(row.reason || ""), by: String(row.by_name), amountCents: number(row.delta_balance_cents) })),
    stillOwed: await listUnresolvedVoidMoney(BUSINESS),
    generatedAt: now.toISOString(),
  };
}

export type ManagerReport = Awaited<ReturnType<typeof managerReport>>;
