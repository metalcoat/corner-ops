import "../../order/order.css";
export default async function SignIn({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return (
    <main className="customerOrder confirmationPage">
      <section className="confirmationCard">
        <p className="eyebrow">Corner Deli account</p>
        <h1>Sign in</h1>
        <p>See loyalty rewards, saved details, and past orders.</p>
        {error && <p className="orderError">{error}</p>}
        <a
          className="reviewButton confirmationButton"
          href="/api/customer/auth/google"
        >
          Continue with Google
        </a>
        <p className="confirmationEmail">
          Email-code and password sign-in are coming next.
        </p>
      </section>
    </main>
  );
}
