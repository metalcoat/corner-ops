import { paymentProviderStatus, testActivePaymentProvider } from "@/lib/payment-provider";
import { orderingActor } from "@/lib/ordering-route-auth";
import { unauthorized } from "@/lib/http";

export const runtime = "nodejs";
const business = "Corner Deli" as const;

export async function GET() {
  if (!(await orderingActor(business))) return unauthorized();
  return Response.json(paymentProviderStatus());
}

export async function POST() {
  if (!(await orderingActor(business))) return unauthorized();
  try {
    return Response.json(await testActivePaymentProvider());
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Payment provider test failed." },
      { status: 409 },
    );
  }
}
