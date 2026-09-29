import { apiError } from "@/lib/http";
import { createManagerRemake, remakeManager, remakeOrderDetail, remakeSearch } from "@/lib/ordering-remakes";
import { externalPrintSettings } from "@/lib/ordering-auto-print";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    if (!await remakeManager()) return Response.json({ error: "Manager access required." }, { status: 403 });
    const url = new URL(request.url);
    if (url.searchParams.has("settings")) return Response.json({ printSettings: await externalPrintSettings("Corner Deli") });
    const id = url.searchParams.get("id");
    if (id) {
      const order = await remakeOrderDetail(id);
      return order ? Response.json({ order }) : Response.json({ error: "Order not found." }, { status: 404 });
    }
    return Response.json({ orders: await remakeSearch(url.searchParams.get("q") || "") });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    const actor = await remakeManager();
    if (!actor) return Response.json({ error: "Manager access required." }, { status: 403 });
    const result = await createManagerRemake(await request.json(), actor);
    return Response.json(result, { status: result.alreadyCreated ? 200 : 201 });
  } catch (error) {
    if (error instanceof SyntaxError) return Response.json({ error: "Invalid request." }, { status: 400 });
    if (error instanceof Error && /^(Choose|Enter|Describe|Customer|A selected|Delivery address|No driving route|Manager access)/.test(error.message)) return Response.json({ error: error.message }, { status: 400 });
    return apiError(error);
  }
}
