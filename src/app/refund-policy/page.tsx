import PolicyPage from "../policy-page/policy-page";

export const metadata = {
  title: "Refund Policy | Corner Deli",
};

export default function RefundPolicyPage() {
  return (
    <PolicyPage>
      <h1>Corner Deli Refund Policy</h1>
      <p><strong>Effective date:</strong> October 20, 2026</p>

      <h2>All sales are final</h2>
      <p>
        All online orders placed with Corner Deli are final. Once an order is placed, it cannot be
        cancelled, and no refunds are given.
      </p>

      <h2>Before you place your order</h2>
      <p>
        Please check your items, quantities, pickup or delivery details, and payment method before
        you place your order. We start preparing orders as soon as they are sent to Corner Deli.
      </p>

      <h2>Questions</h2>
      <p>
        If you have a question about your order, call Corner Deli at{" "}
        <a href="tel:+13153932271">(315) 393-2271</a>.
      </p>

      <p><a href="/order">Back to ordering</a></p>
    </PolicyPage>
  );
}
