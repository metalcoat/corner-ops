import { apiError, unauthorized } from "@/lib/http";
import { orderingActor } from "@/lib/ordering-route-auth";
import {
  tipAction,
  tipCsv,
  TipError,
  tipsDashboard,
} from "@/lib/ordering-tips";
export const runtime = "nodejs";
export async function GET(request: Request) {
  if (!(await orderingActor("Corner Deli"))) return unauthorized();
  try {
    if (new URL(request.url).searchParams.get("export") === "csv")
      return new Response(await tipCsv(), {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="corner-deli-tips-${new Date().toISOString().slice(0, 10)}.csv"`,
        },
      });
    return Response.json(await tipsDashboard());
  } catch (error) {
    return apiError(error);
  }
}
export async function POST(request: Request) {
  const actor = await orderingActor("Corner Deli");
  if (!actor) return unauthorized();
  try {
    return Response.json(await tipAction(await request.json(), actor), {
      status: 201,
    });
  } catch (error) {
    if (error instanceof TipError)
      return Response.json({ error: error.message }, { status: 409 });
    return apiError(error);
  }
}
