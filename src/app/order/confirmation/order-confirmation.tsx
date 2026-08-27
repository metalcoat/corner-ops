"use client";

import { useEffect, useState } from "react";
import "../order.css";

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export default function OrderConfirmation({ orderId }: { orderId: string }) {
  const [order, setOrder] = useState<any>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!orderId) {
      setError("This confirmation link is incomplete.");
      return;
    }
    fetch(`/api/customer/orders/${encodeURIComponent(orderId)}`, {
      cache: "no-store",
    })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok)
          throw new Error(body.error || "Could not load this order.");
        setOrder(body.order);
      })
      .catch((reason) =>
        setError(
          reason instanceof Error
            ? reason.message
            : "Could not load this order.",
        ),
      );
  }, [orderId]);
  return (
    <main className="customerOrder confirmationPage">
      <section className="confirmationCard" aria-live="polite">
        {error ? (
          <>
            <p className="eyebrow">Confirmation unavailable</p>
            <h1>{error}</h1>
            <a href="/order">Return to online ordering</a>
          </>
        ) : !order ? (
          <h1>Confirming your order…</h1>
        ) : (
          <>
            <div className="confirmationCheck">✓</div>
            <p className="eyebrow">Order confirmed</p>
            <h1>Thank you, {order.first_name_snapshot}!</h1>
            <p>
              {order.payment_status === "paid"
                ? "Your payment was approved and order "
                : "Your order "}
              <strong>#{order.display_number}</strong> was sent to Corner Deli.
            </p>
            <div className="confirmationTiming">
              <span>Pickup</span>
              <strong>
                {order.timing_message_snapshot || "Pickup time confirmed"}
              </strong>
            </div>
            <div className="confirmationLines">
              {order.lines.map((line: any, index: number) => (
                <div key={index}>
                  <span>
                    {line.quantity}×{" "}
                    {line.variant_name ? `${line.variant_name} ` : ""}
                    {line.name}
                  </span>
                  <strong>{money(line.line_total_cents)}</strong>
                </div>
              ))}
              <div className="confirmationTotal">
                <span>
                  {order.payment_status === "paid"
                    ? "Total paid"
                    : "Due at pickup"}
                </span>
                <strong>
                  {money(
                    order.payment_status === "paid"
                      ? order.paid_cents
                      : order.total_cents,
                  )}
                </strong>
              </div>
            </div>
            <p className="confirmationEmail">
              {order.email_delivery_configured ? (
                <>
                  A copy of these order details will be sent to{" "}
                  <strong>{order.email_snapshot}</strong>.
                </>
              ) : (
                <>
                  Please save this confirmation. Email receipts are temporarily
                  unavailable.
                </>
              )}
            </p>
            <a className="reviewButton confirmationButton" href="/order">
              Start another order
            </a>
          </>
        )}
      </section>
    </main>
  );
}
