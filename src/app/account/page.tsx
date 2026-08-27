"use client";
import { useEffect, useState } from "react";
import "../order/order.css";
const money = (c: number) => `$${(c / 100).toFixed(2)}`;
export default function Account() {
  const [data, setData] = useState<any>(null),
    [error, setError] = useState("");
  useEffect(() => {
    fetch("/api/customer/account", { cache: "no-store" })
      .then(async (r) => {
        const b = await r.json();
        if (r.status === 401) {
          location.href = "/account/sign-in";
          return;
        }
        if (!r.ok) throw new Error(b.error);
        setData(b);
      })
      .catch((e) => setError(e.message));
  }, []);
  async function signOut() {
    await fetch("/api/customer/auth/session", { method: "DELETE" });
    location.href = "/order";
  }
  return (
    <main className="customerOrder confirmationPage">
      <section className="confirmationCard">
        {error ? (
          <p className="orderError">{error}</p>
        ) : !data ? (
          <h1>Loading your account…</h1>
        ) : (
          <>
            <p className="eyebrow">Corner Deli account</p>
            <h1>
              Hi, {data.customer.first_name || data.customer.display_name}
            </h1>
            <h2>Loyalty</h2>
            {data.programs.length ? (
              data.programs.map((p: any) => (
                <p key={p.programId}>
                  <strong>{p.name}</strong>: {p.progress} of{" "}
                  {p.quantityRequired} · {p.rewardsAvailable} rewards available
                </p>
              ))
            ) : (
              <p>No loyalty activity yet.</p>
            )}
            <h2>Past orders</h2>
            {data.orders.length ? (
              data.orders.map((o: any) => (
                <div className="confirmationLines" key={o.id}>
                  <div>
                    <span>
                      Order #{o.display_number} ·{" "}
                      {new Date(o.created_at).toLocaleDateString()}
                    </span>
                    <strong>{money(o.total_cents)}</strong>
                  </div>
                </div>
              ))
            ) : (
              <p>No past orders yet.</p>
            )}
            <a className="reviewButton confirmationButton" href="/order">
              Order again
            </a>
            <button
              className="reviewButton confirmationButton"
              onClick={() => void signOut()}
            >
              Sign out
            </button>
          </>
        )}
      </section>
    </main>
  );
}
