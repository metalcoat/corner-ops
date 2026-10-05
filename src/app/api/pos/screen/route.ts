import { currentScreen, listScreens, revokeScreen, screenSigner, signInScreen, signOutScreen, type ScreenKind } from "@/lib/screen-auth";

export const runtime = "nodejs";
const kindFrom = (value: unknown): ScreenKind => {
  if (value === "board" || value === "labels") return value;
  throw new Error("Unknown screen.");
};
const fail = (error: unknown, status = 400) => Response.json({ error: error instanceof Error ? error.message : "Screen update failed." }, { status });

/** ?kind=board|labels → this screen's pass; ?list=1 → every signed-in screen (managers). */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    if (url.searchParams.get("list") === "1") {
      const signer = await screenSigner();
      if (!signer?.manager) return Response.json({ error: "Manager access required." }, { status: 403 });
      return Response.json({ screens: await listScreens() });
    }
    const kind = kindFrom(url.searchParams.get("kind"));
    return Response.json({ screen: await currentScreen(kind), signedIn: Boolean(await screenSigner()) });
  } catch (error) {
    return fail(error);
  }
}

/** Keep this screen signed in for one view. */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    return Response.json({ screen: await signInScreen(kindFrom(body.kind), String(body.name || "")) });
  } catch (error) {
    return fail(error, 401);
  }
}

/** ?kind=… signs this screen out; ?id=… lets a manager sign out another screen. */
export async function DELETE(request: Request) {
  try {
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    if (id) {
      const signer = await screenSigner();
      if (!signer?.manager) return Response.json({ error: "Manager access required." }, { status: 403 });
      await revokeScreen(id);
    } else await signOutScreen(kindFrom(url.searchParams.get("kind")));
    return Response.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
