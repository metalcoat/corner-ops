"use client";

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

let activeSync: Promise<{ synced: number; remaining: number }> | null = null;

async function runSync(): Promise<{ synced: number; remaining: number }> {
  if (!navigator.onLine) return { synced: 0, remaining: offlineOrders().length };
  let synced = 0;
  const rows = offlineOrders();
  for (const row of [...rows]) {
    try {
      const response = await fetch("/api/ordering/offline-sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(row),
      });
      const body = await response.json();
      if (!response.ok) {
        row.status = "conflict";
        row.error = body.error || "Manual review is required.";
        continue;
      }
      rows.splice(rows.indexOf(row), 1);
      synced += 1;
    } catch { break; }
  }
  save(rows);
  return { synced, remaining: rows.length };
}

export function syncOfflineOrders(): Promise<{ synced: number; remaining: number }> {
  if (activeSync) return activeSync;
  activeSync = runSync().finally(() => { activeSync = null; });
  return activeSync;
}
