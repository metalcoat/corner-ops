import { clearEmployeeSession, createEmployeeSession, getEmployeeSession } from "@/lib/employee-auth";
import { apiError } from "@/lib/http";
import type { Business } from "@/lib/types";

export const runtime = "nodejs";

function businessFrom(value: unknown): Business {
  if (value === "Corner Deli" || value === "Tiki") return value;
  throw new Error("Choose Corner Deli or Tiki.");
}

export async function GET() {
  const session = await getEmployeeSession();
  return Response.json({ authenticated: Boolean(session), session });
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const session = await createEmployeeSession(businessFrom(body.business), String(body.pin || ""));
    return Response.json({ authenticated: true, session });
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE() {
  await clearEmployeeSession();
  return Response.json({ authenticated: false });
}
