import { apiError } from "@/lib/http";
import { exchangeSquareAuthorization } from "@/lib/integrations";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const error = url.searchParams.get("error");
    if (error) {
      return Response.redirect(`${url.origin}/ops/integrations?square=denied`, 302);
    }
    const code = url.searchParams.get("code") || "";
    const state = url.searchParams.get("state") || "";
    if (!code || !state) {
      return Response.json({ error: "Square callback was missing its authorization code or state." }, { status: 400 });
    }
    const result = await exchangeSquareAuthorization(code, state);
    return Response.redirect(`${result.origin}/ops/integrations?square=connected`, 302);
  } catch (error) {
    return apiError(error);
  }
}
