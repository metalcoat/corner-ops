import PolicyPage from "../policy-page/policy-page";

export const metadata = {
  title: "Delivery & Pickup Policy | Corner Deli",
};

export default function DeliveryPolicyPage() {
  return (
    <PolicyPage>
      <h1>Corner Deli Delivery &amp; Pickup Policy</h1>
      <p><strong>Effective date:</strong> October 26, 2026</p>

      <h2>Where we deliver</h2>
      <p>
        We deliver in and around Ogdensburg, New York. Your address is checked when you order; if it is
        outside our delivery area you will be told before you pay. The delivery fee is based on driving
        distance and is shown, along with any delivery minimum, before you place your order.
      </p>

      <h2>When</h2>
      <p>
        Online ordering is available during the ordering hours shown on the order page. Most delivery
        orders arrive in about 40 to 55 minutes; pickup orders are usually ready sooner, and the order
        page shows the current estimate. On very busy days it can take longer. Scheduled orders are
        prepared for the time you choose.
      </p>

      <h2>Payment</h2>
      <p>
        Pay by card when you order, or, where offered, pay when you pick up or when your order is
        delivered. All prices are in U.S. dollars. A tip for the driver is optional.
      </p>

      <h2>Pickup</h2>
      <p>
        Pick up your order at Corner Deli, 828 Morris St, Ogdensburg, NY 13669. Please bring your order
        number or the name on the order.
      </p>

      <h2>If something goes wrong</h2>
      <p>
        Please make sure your address, phone number and delivery notes are correct so the driver can reach
        you. If there is a problem with a delivery or pickup, call us right away at{" "}
        <a href="tel:+13153932271">(315) 393-2271</a>. Orders cannot be cancelled once placed; see our{" "}
        <a href="/refund-policy">Refund &amp; Cancellation Policy</a>.
      </p>
    </PolicyPage>
  );
}
