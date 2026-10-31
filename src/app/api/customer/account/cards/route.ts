import { isoJson } from "@/lib/timestamp-values";
import { customerSessionHash, readCustomerOrderingSession } from "@/lib/customer-ordering-session";
import { MxMerchantError } from "@/lib/mx-merchant";
import { listSavedCards, removeSavedCard, startCardSave, syncSavedCards } from "@/lib/mx-saved-cards";
import { limitCardCheckoutStart } from "@/lib/customer-abuse-limits";
import { RateLimitError } from "@/lib/http";

export const runtime = "nodejs";

/** A signed-in customer's saved cards: list, start saving one (browser → MX vault), record it, remove one. */
export async function GET(request: Request) {
  const session = readCustomerOrderingSession(request);
  if (!session?.customerId || !session.authenticatedAt) return isoJson({ error: "Sign in required." }, { status: 401 });
  return isoJson({ cards: await listSavedCards(session.customerId) });
}

export async function POST(request: Request) {
  const session = readCustomerOrderingSession(request);
  if (!session?.customerId || !session.authenticatedAt) return isoJson({ error: "Sign in required." }, { status: 401 });
  try {
    const body = (await request.json()) as Record<string, unknown>;
    if (body.action === "start") {
      // Each start hands out an MX token: same limit as card checkout.
      await limitCardCheckoutStart(request, customerSessionHash(session.sessionId));
      return isoJson(await startCardSave(session.customerId));
    }
    if (body.action === "saved") {
      // The browser saved a card at MX; the customer ticked "Save this card".
      const source = body.source === "account" ? "account_page" : "online_checkout";
      return isoJson({ cards: await syncSavedCards(session.customerId, `customer:${source}`) });
    }
    if (body.action === "remove") return isoJson({ cards: await removeSavedCard(session.customerId, String(body.id || "")) });
    return isoJson({ error: "Unknown action." }, { status: 400 });
  } catch (error) {
    if (error instanceof RateLimitError) return isoJson({ error: "Too many attempts. Please wait an hour." }, { status: 429 });
    if (error instanceof MxMerchantError) return isoJson({ error: error.message }, { status: 409 });
    console.error("[saved cards]", error);
    return isoJson({ error: "Saved cards are unavailable right now." }, { status: 500 });
  }
}
