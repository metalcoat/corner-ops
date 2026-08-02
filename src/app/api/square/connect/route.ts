import { getSession } from "@/lib/auth";
import { apiError, unauthorized } from "@/lib/http";
import { squareAuthorizationUrl } from "@/lib/integrations";

export async function GET(request: Request) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    return Response.redirect(squareAuthorizationUrl(new URL(request.url).origin), 302);
  } catch (error) {
    return apiError(error);
  }
}
