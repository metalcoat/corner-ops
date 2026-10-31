"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import PosClient from "../../pos-client";
type Session = {
  id: string;
  tableLabel: string;
  guest_count: number;
  server_name: string;
  conceptName: string;
  order_id?: string | null;
};
export default function RestaurantOrderClient() {
  const [table, setTable] = useState<Session | null>(null);
  useEffect(() => {
    try {
      const raw = localStorage.getItem("restaurant-table-session");
      if (raw) setTable(JSON.parse(raw));
    } catch {
      /* Invalid handoff is treated as no selected table. */
    }
  }, []);
  if (!table)
    return (
      <main className="restaurantOrderEmpty">
        <h1>Select a table first</h1>
        <Link href="/pos/restaurant">OPEN FLOOR PLAN</Link>
      </main>
    );
  return (
    <main className="restaurantOrder">
      <header>
        <div>
          <small>{table.conceptName || "TABLE SERVICE"}</small>
          <h1>
            {table.tableLabel} · {table.guest_count} guests
          </h1>
          <p>Server: {table.server_name}</p>
        </div>
        <Link href="/pos/restaurant">FLOOR PLAN</Link>
      </header>
      <PosClient
        business="Tiki"
        embedded
        initialServiceType="dine_in"
        tableSessionId={table.id}
      />
    </main>
  );
}
