import { apiError, unauthorized } from "@/lib/http";
import type { OrderingBusiness } from "@/lib/ordering-core";
import { checkoutState, commitTender, PaymentConflictError, reprintPaymentReceipt, reverseTender, type CheckoutTenderType } from "@/lib/ordering-payments";
import { canManagePos, orderingActor } from "@/lib/ordering-route-auth";
import { dispatchOrderPrintJobs } from "@/lib/ordering-hardware";
import { paymentStationProfile, PaymentStationError } from "@/lib/ordering-payment-stations";

export const runtime = "nodejs";

function businessFrom(value: unknown): OrderingBusiness {
  if (value === "Corner Deli" || value === "Tiki") return value;
  throw new PaymentConflictError("Unknown business.");
}

function tenderFrom(value: unknown): CheckoutTenderType {
  if (value === "cash" || value === "card" || value === "gift_card") return value;
  throw new PaymentConflictError("Cash, approved credit/debit, or gift card tender is required.");
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const url = new URL(request.url);
    const business = businessFrom(url.searchParams.get("business"));
    if (!await orderingActor(business)) return unauthorized();
    const { id } = await context.params;
    return Response.json(await checkoutState(id, business, url.searchParams.get("checkId")));
  } catch (error) {
    if (error instanceof PaymentConflictError) return Response.json({ error: error.message }, { status: 409 });
    return apiError(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const business = businessFrom(body.business);
    const actor = await orderingActor(business);
    if (!actor) return unauthorized();
    const { id } = await context.params;
    const stationKey=String(body.stationKey||"");
    const station=stationKey?await paymentStationProfile(business,stationKey):null;
    if(station?.station_mode==="order_taker")throw new PaymentStationError("This device is an order-taking station. Send the check to the payment station.");
    if (body.action === "reverse") return Response.json(await reverseTender({orderId:id,business,transactionId:String(body.transactionId||""),amountCents:Number(body.amountCents),clientMutationId:String(body.clientMutationId||""),reason:String(body.reason||""),actor}),{status:201});
    if (body.action === "reprint") {const result=await reprintPaymentReceipt({orderId:id,business,transactionId:String(body.transactionId||""),reason:String(body.reason||""),actor});await dispatchOrderPrintJobs(id,business,{includeKitchenProduction:false});return Response.json(result,{status:201})}
    const result=await commitTender({
      orderId: id,
      business,
      tenderType: tenderFrom(body.tenderType),
      amountTenderedCents: Number(body.amountTenderedCents),
      clientMutationId: String(body.clientMutationId || ""),
      checkId: body.checkId ? String(body.checkId) : null,
      actor,
      receiptPrinterId: body.receiptPrinterId ? String(body.receiptPrinterId) : undefined,
      cashControlMode: "till",
      stationKey,
      giftCardNumber: body.giftCardNumber ? String(body.giftCardNumber) : undefined,
      giftCardPin: body.giftCardPin ? String(body.giftCardPin) : undefined,
      providerApproval: body.testCard === true && process.env.LOCAL_DEVELOPMENT === "true" && canManagePos(actor) ? {
        provider: "test",
        transactionReference: `local-test-${String(body.clientMutationId || "")}`,
        brand: "TEST",
        last4: "4242",
        details: { simulated: true, localDevelopment: true },
      } : undefined,
    });await dispatchOrderPrintJobs(id,business,{includeKitchenProduction:false});return Response.json(result,{status:201});
  } catch (error) {
    if (error instanceof PaymentConflictError || error instanceof PaymentStationError) return Response.json({ error: error.message }, { status: 409 });
    return apiError(error);
  }
}
