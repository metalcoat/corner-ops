import { NextResponse } from "next/server";
import { canManagePos, orderingActor } from "@/lib/ordering-route-auth";
import { greeterVolumes, saveGreeterVolumes } from "@/lib/greeter-tv-settings";

export const runtime = "nodejs";

async function manager() {
  const actor = await orderingActor("Corner Deli");
  return actor && canManagePos(actor) ? actor : null;
}

export async function GET() {
  if (!(await manager())) return NextResponse.json({ error: "Manager sign-in required." }, { status: 403 });
  return NextResponse.json(await greeterVolumes(), { headers: { "cache-control": "no-store" } });
}

export async function PATCH(request: Request) {
  const actor = await manager();
  if (!actor) return NextResponse.json({ error: "Manager sign-in required." }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as { music?: number; greeting?: number };
  const current = await greeterVolumes();
  return NextResponse.json(await saveGreeterVolumes({ music: body.music ?? current.music, greeting: body.greeting ?? current.greeting }, actor.name));
}
