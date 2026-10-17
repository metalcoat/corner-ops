"use client";

import { classifyOfflineSyncStatus } from "@/lib/pos-offline-sync-policy";

export type OfflineCashOrder = {
  id: string;
  createdAt: string;
  orderBody: Record<string, unknown>;
  amountTenderedCents: number | null;
  stationKey: string;
  status: "pending" | "conflict";
  error?: string;
};

const STORAGE_KEY = "corner-ops-offline-orders-v1";

export function offlineOrders(): OfflineCashOrder[] {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}

function save(rows: OfflineCashOrder[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(rows));
  window.dispatchEvent(new Event("corner-ops-offline-queue"));
}

export function queueOfflineOrder(row: Omit<OfflineCashOrder, "status">) {
  const rows = offlineOrders();
  if (!rows.some((item) => item.id === row.id)) rows.push({ ...row, status: "pending" });
  save(rows);
}

export type OfflineSyncResult = { synced: number; remaining: number; conflicts: OfflineCashOrder[] };

function summary(synced: number): OfflineSyncResult {
  const rows = offlineOrders();
  return { synced, remaining: rows.filter((row) => row.status !== "conflict").length, conflicts: rows.filter((row) => row.status === "conflict") };
}

/** Rows staff must review: the server rejected them and they are no longer auto-retried. */
export function offlineConflicts(): OfflineCashOrder[] {
  return offlineOrders().filter((row) => row.status === "conflict");
}

let activeSync: Promise<OfflineSyncResult> | null = null;

async function runSync(): Promise<OfflineSyncResult> {
  if (!navigator.onLine) return summary(0);
  let synced = 0;
  const removed = new Set<string>(), updated = new Map<string, OfflineCashOrder>();
  for (const row of offlineOrders().filter((item) => item.status !== "conflict")) {
    let outcome: ReturnType<typeof classifyOfflineSyncStatus>, error = "";
    try {
      const response = await fetch("/api/ordering/offline-sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(row),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      outcome = classifyOfflineSyncStatus(response.status);
      error = body.error || "Manual review is required.";
    } catch { break; }
    if (outcome === "retry") break; // Server or session trouble: keep order and try again later.
    if (outcome === "conflict") { updated.set(row.id, { ...row, status: "conflict", error }); continue; }
    removed.add(row.id);
    synced += 1;
  }
  // Merge with storage so an order queued while this sync ran is never lost.
  save(offlineOrders().filter((row) => !removed.has(row.id)).map((row) => updated.get(row.id) || row));
  return summary(synced);
}

export function syncOfflineOrders(): Promise<OfflineSyncResult> {
  if (activeSync) return activeSync;
  activeSync = runSync().finally(() => { activeSync = null; });
  return activeSync;
}

/** Put a reviewed conflict back in the queue and attempt it again now. */
export function retryOfflineOrder(id: string): Promise<OfflineSyncResult> {
  save(offlineOrders().map((row) => row.id === id ? { ...row, status: "pending" as const, error: undefined } : row));
  return syncOfflineOrders();
}

/** Discard a conflict after staff have handled the order manually. */
export function dismissOfflineOrder(id: string) {
  save(offlineOrders().filter((row) => row.id !== id));
}
