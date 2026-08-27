import type { Metadata } from "next";
import OrderConfirmation from "./order-confirmation";

export const metadata: Metadata = { title: "Order confirmed | Corner Deli" };

export default async function ConfirmationPage({
  searchParams,
}: {
  searchParams: Promise<{ orderId?: string }>;
}) {
  const { orderId = "" } = await searchParams;
  return <OrderConfirmation orderId={orderId} />;
}
