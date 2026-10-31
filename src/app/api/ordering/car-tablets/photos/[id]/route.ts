import { apiError } from "@/lib/http";
import { orderingActor } from "@/lib/ordering-route-auth";
import { photoFile } from "@/lib/car-tablet";

export const runtime = "nodejs";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!(await orderingActor("Corner Deli"))) return Response.json({ error: "POS sign-in required." }, { status: 401 });
    const photo = await photoFile("Corner Deli", (await params).id);
    if (!photo) return Response.json({ error: "Photo not found." }, { status: 404 });
    return new Response(photo.stream, { headers: { "Content-Type": photo.mimeType, "Cache-Control": "private, max-age=86400" } });
  } catch (error) {
    return apiError(error);
  }
}
