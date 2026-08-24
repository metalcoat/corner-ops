"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
type Data = {
  concept: { display_name: string };
  actor: { name: string; role?: string };
  floors: Array<{ id: string; name: string; width: number; height: number }>;
  sections: Array<{
    id: string;
    floor_plan_id: string;
    name: string;
    color: string;
  }>;
  tables: Array<{
    id: string;
    floor_plan_id: string;
    section_id: string | null;
    table_number: string;
    label: string;
    seats: number;
    shape: string;
    x: number;
    y: number;
    width: number;
    height: number;
    section_name?: string;
    color?: string;
    session_id?: string;
    server_name?: string;
    guest_count?: number;
    session_status?: string;
    display_number?: string;
    total_cents?: number;
  }>;
};
export default function RestaurantFloorClient() {
  const [data, setData] = useState<Data | null>(null),
    [error, setError] = useState(""),
    [selectedFloor, setSelectedFloor] = useState(""),
    [editing, setEditing] = useState(false),
    [name, setName] = useState(""),
    [number, setNumber] = useState(""),
    [seats, setSeats] = useState(4),
    [section, setSection] = useState("");
  async function load() {
    const response = await fetch("/api/restaurant-platform", {
        cache: "no-store",
      }),
      body = await response.json();
    if (!response.ok)
      throw new Error(body.error || "Could not load restaurant.");
    setData(body);
    setSelectedFloor((current) => current || body.floors[0]?.id || "");
  }
  useEffect(() => { void load().catch((cause) => setError(cause.message)); }, []);
  async function action(body: Record<string, unknown>) {
    setError("");
    const response = await fetch("/api/restaurant-platform", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      result = await response.json();
    if (!response.ok) throw new Error(result.error || "Update failed.");
    await load();
    return result;
  }
  async function openTable(table: Data["tables"][number]) {
    const raw = window.prompt(
      `Guests at ${table.label}?`,
      String(table.guest_count || table.seats),
    );
    if (!raw) return;
    try {
      const opened = await action({
        action: "open_table",
        tableId: table.id,
        guestCount: Number(raw),
      });
      localStorage.setItem(
        "restaurant-table-session",
        JSON.stringify({
          ...opened,
          tableLabel: table.label,
          conceptName: data?.concept.display_name,
        }),
      );
      window.location.href = "/pos/restaurant/order";
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not open table.",
      );
    }
  }
  if (!data)
    return (
      <main className="restaurantGate">
        <p>{error || "Loading…"}</p>
        {error && <Link href="/signin">SIGN IN</Link>}
      </main>
    );
  const floor = data.floors.find((row) => row.id === selectedFloor),
    tables =
      data.tables.filter((row) => row.floor_plan_id === selectedFloor) || [],
    manager = data.actor.role === "manager" || data.actor.role === "owner";
  return (
    <main className="restaurantPage">
      <header>
        <div>
          <small>TABLE SERVICE</small>
          <h1>{data?.concept.display_name || "New Restaurant"}</h1>
          <p>
            {data?.actor.name} · {tables.filter((row) => row.session_id).length}{" "}
            occupied / {tables.length} tables
          </p>
        </div>
        <nav>
          <Link href="/pos/restaurant/order">CURRENT ORDER</Link>
          <Link href="/pos/tiki">TIKI POS</Link>
        </nav>
      </header>
      {error && (
        <p className="restaurantError" role="alert">
          {error}
        </p>
      )}
      <div className="floorToolbar">
        <select
          aria-label="Floor plan"
          value={selectedFloor}
          onChange={(event) => setSelectedFloor(event.target.value)}
        >
          {data?.floors.map((row) => (
            <option key={row.id} value={row.id}>
              {row.name}
            </option>
          ))}
        </select>
        {manager && (
          <button onClick={() => setEditing((value) => !value)}>
            {editing ? "DONE EDITING" : "EDIT FLOOR"}
          </button>
        )}
      </div>
      {editing && manager && (
        <section className="floorEditor">
          <h2>Add table</h2>
          <input
            placeholder="Table number"
            value={number}
            onChange={(event) => setNumber(event.target.value)}
          />
          <input
            placeholder="Display label"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <input
            aria-label="Seats"
            type="number"
            min="1"
            max="50"
            value={seats}
            onChange={(event) => setSeats(Number(event.target.value))}
          />
          <select
            value={section}
            onChange={(event) => setSection(event.target.value)}
          >
            <option value="">No section</option>
            {data?.sections
              .filter((row) => row.floor_plan_id === selectedFloor)
              .map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
          </select>
          <button
            disabled={!number || !floor}
            onClick={() =>
              void action({
                action: "save_table",
                floorPlanId: selectedFloor,
                tableNumber: number,
                label: name || number,
                seats,
                sectionId: section || null,
                x: 40 + (tables.length % 6) * 145,
                y: 40 + Math.floor(tables.length / 6) * 110,
              })
                .then(() => {
                  setNumber("");
                  setName("");
                })
                .catch((cause) => setError(cause.message))
            }
          >
            ADD TABLE
          </button>
        </section>
      )}
      <section
        className="floorCanvas"
        style={{
          aspectRatio: `${floor?.width || 1200}/${floor?.height || 800}`,
        }}
      >
        {tables.length ? (
          tables.map((table) => (
            <button
              key={table.id}
              className={`diningTable ${table.session_id ? "occupied" : "available"}`}
              style={{
                left: `${(table.x / (floor?.width || 1200)) * 100}%`,
                top: `${(table.y / (floor?.height || 800)) * 100}%`,
                width: `${(table.width / (floor?.width || 1200)) * 100}%`,
                height: `${(table.height / (floor?.height || 800)) * 100}%`,
                borderColor: table.color || undefined,
                borderRadius: table.shape === "round" ? "50%" : undefined,
              }}
              onClick={() => void openTable(table)}
            >
              <strong>{table.label}</strong>
              <span>
                {table.session_id
                  ? `${table.guest_count} guests · ${table.server_name}`
                  : `${table.seats} seats`}
              </span>
              {table.display_number && (
                <small>
                  #{table.display_number} · $
                  {(Number(table.total_cents || 0) / 100).toLocaleString(
                    "en-US",
                    { style: "currency", currency: "USD" },
                  )}
                </small>
              )}
            </button>
          ))
        ) : (
          <p className="emptyFloor">
            No tables yet. Choose Edit Floor to add the first table.
          </p>
        )}
      </section>
    </main>
  );
}
