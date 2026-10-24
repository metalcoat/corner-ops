import { remindUnresolvedVoidMoney } from "@/lib/ordering-void-money";
import { releaseHeldKitchenOrders } from "@/lib/ordering-auto-print";
import type { OrderingBusiness } from "@/lib/ordering-core";
import { retryDuePrintJobs } from "@/lib/ordering-hardware";
import { restoreAbandonedReopenedOrders } from "@/lib/ordering-order-lifecycle";
import { captureStaleTerminalAuthorizations } from "@/lib/mx-terminal-payments";

const OPPORTUNISTIC_INTERVAL_MS = 20_000;
const lastRun = new Map<OrderingBusiness, number>();

/** Retries due print jobs, restores abandoned reopened orders, and charges terminal cards left waiting for a tip. */
export async function runOrderingMaintenance(business: OrderingBusiness) {
  const print = await retryDuePrintJobs(business).catch((error) => {
    console.error("Print retry sweep failed", error);
    return { orders: 0 };
  });
  const reopen = await restoreAbandonedReopenedOrders(business).catch((error) => {
    console.error("Reopened-order sweep failed", error);
    return { restored: 0 };
  });
  const terminal = await captureStaleTerminalAuthorizations(business).catch((error) => {
    console.error("Terminal auto-capture sweep failed", error);
    return { captured: 0 };
  });
  const held = await releaseHeldKitchenOrders(business).catch((error) => {
    console.error("Scheduled-order release sweep failed", error);
    return { released: 0 };
  });
  const voidMoney = await remindUnresolvedVoidMoney(business).catch((error) => {
    console.error("Voided-money reminder failed", error);
    return { sent: false };
  });
  return { business, voidMoneyReminderSent: voidMoney.sent, printRetryOrders: print.orders, restoredReopenedOrders: reopen.restored, terminalCardsCaptured: terminal.captured, scheduledOrdersReleased: held.released };
}

/**
 * Throttled variant for busy polling endpoints (the kitchen display polls
 * every few seconds), so the sweeps run without a scheduler but not on every
 * request.
 */
export async function runOrderingMaintenanceOpportunistically(business: OrderingBusiness) {
  const now = Date.now();
  if (now - (lastRun.get(business) || 0) < OPPORTUNISTIC_INTERVAL_MS) return null;
  lastRun.set(business, now);
  return runOrderingMaintenance(business);
}
