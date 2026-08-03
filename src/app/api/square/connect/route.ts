import { getSession, requirePermission } from "@/lib/auth";
import { apiError, unauthorized } from "@/lib/http";
import { squareFullAuthorizationUrl } from "@/lib/square-control";

export async function GET(request: Request) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    requirePermission(session, "integrations.write");
    return Response.redirect(squareFullAuthorizationUrl(new URL(request.url).origin), 302);
  } catch (error) {
    return apiError(error);
  }
}
