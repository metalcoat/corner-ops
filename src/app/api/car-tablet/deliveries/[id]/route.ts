import { ValidationError } from "@/lib/http";
import { withTablet } from "@/lib/car-tablet-route";
import { TABLET_ACTIONS, tabletDeliveryAction, type TabletAction } from "@/lib/car-tablet";

export const runtime = "nodejs";

/** claim, picked_up (leaving now), arrived, delivered, no_contact, failed, returned. */
export function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withTablet(request, async (tablet) => {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const action = String(body.action || "") as TabletAction;
    if (!TABLET_ACTIONS.includes(action)) throw new ValidationError("Unknown delivery action.");
    return tabletDeliveryAction(tablet, (await params).id, action, String(body.note || ""));
  });
}
