import { canAccessBusiness, getSession } from "@/lib/auth";
import { apiError, unauthorized } from "@/lib/http";
import type { OrderingBusiness } from "@/lib/ordering-core";
import { createMenuImportPreview, type ImportedMenuSnapshot } from "@/lib/ordering-menu-import";

export const runtime = "nodejs";

function readBusiness(value: unknown): OrderingBusiness {
  if (value === "Corner Deli" || value === "Tiki") return value;
  throw new Error("Unknown business.");
}

export async function POST(request: Request) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    if (session.role !== "Owner" && session.role !== "Co-Owner") {
      return Response.json({ error: "Only an owner or co-owner can create menu import previews." }, { status: 403 });
    }

    const body = await request.json() as ImportedMenuSnapshot;
    const business = readBusiness(body.business);
    if (!canAccessBusiness(session, business)) {
      return Response.json({ error: "Business access denied." }, { status: 403 });
    }
    if (body.source !== "rezku") {
      return Response.json({ error: "This endpoint accepts Rezku import snapshots only." }, { status: 400 });
    }
    if (!Array.isArray(body.categories)) {
      return Response.json({ error: "The import snapshot must contain categories." }, { status: 400 });
    }

    const result = await createMenuImportPreview({
      snapshot: { ...body, business },
      createdBy: session.email,
    });
    return Response.json(result);
  } catch (error) {
    return apiError(error);
  }
}
