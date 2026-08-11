import { canAccessBusiness, getSession } from "@/lib/auth";
import { apiError, unauthorized } from "@/lib/http";
import { orderingMenu } from "@/lib/ordering-menu";
import type { OrderingBusiness } from "@/lib/ordering-core";

export const runtime = "nodejs";

function readBusiness(value: string | null): OrderingBusiness {
  if (value === "Corner Deli" || value === "Tiki") return value;
  throw new Error("Unknown business.");
}

export async function GET(request: Request) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    const business = readBusiness(new URL(request.url).searchParams.get("business") || "Corner Deli");
    if (!canAccessBusiness(session, business)) {
      return Response.json({ error: "Business access denied." }, { status: 403 });
    }
    return Response.json({ business, categories: await orderingMenu(business) });
  } catch (error) {
    return apiError(error);
  }
}
