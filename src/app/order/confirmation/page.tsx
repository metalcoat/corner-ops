import type { Metadata } from "next";
import OrderConfirmation from "./order-confirmation";

export const metadata: Metadata = { title: "Order confirmed | Corner Deli", robots: { index: false, follow: false } };

export default async function ConfirmationPage({
  searchParams,
}: {
  searchParams: Promise<{ orderId?: string }>;
}) {
  const { orderId = "" } = await searchParams;
  return <OrderConfirmation orderId={orderId} />;
}
