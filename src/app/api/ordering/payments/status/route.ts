import { isoJson } from "@/lib/timestamp-values";
import { paymentProviderStatus, testActivePaymentProvider } from "@/lib/payment-provider";
import { orderingActor } from "@/lib/ordering-route-auth";
import { unauthorized } from "@/lib/http";

export const runtime = "nodejs";
const business = "Corner Deli" as const;

export async function GET() {
  if (!(await orderingActor(business))) return unauthorized();
  return isoJson(paymentProviderStatus());
}

export async function POST() {
  if (!(await orderingActor(business))) return unauthorized();
  try {
    return isoJson(await testActivePaymentProvider());
  } catch (error) {
    return isoJson(
      { error: error instanceof Error ? error.message : "Payment provider test failed." },
      { status: 409 },
    );
  }
}
