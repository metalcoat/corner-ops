import { punchTiki } from "@/lib/operations";
import { apiError } from "@/lib/http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json() as {
      pin?: string;
      latitude?: number | null;
      longitude?: number | null;
      accuracy?: number | null;
    };

    const result = await punchTiki(String(body.pin || ""), {
      latitude: body.latitude,
      longitude: body.longitude,
      accuracy: body.accuracy,
    });
    return Response.json(result);
  } catch (error) {
    return apiError(error);
  }
}
