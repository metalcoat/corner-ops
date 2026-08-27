import "../../order/order.css";
import EmailSignIn from "./email-sign-in";
export default async function SignIn({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error = "" } = await searchParams;
  return <EmailSignIn initialError={error} />;
}
