import { createDeliBoardToken } from "@/lib/deli-board-auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const { token, payload } = await createDeliBoardToken(String(body.pin || ""));
    return Response.json({
      authenticated: true,
      token,
      expiresAt: payload.expiresAt,
      employeeName: payload.employeeName,
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unable to activate Deli Board." }, { status: 401 });
  }
}
