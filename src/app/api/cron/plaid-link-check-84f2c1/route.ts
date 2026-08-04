import { createResilientPlaidLinkToken } from "@/lib/plaid-link";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const result = await createResilientPlaidLinkToken({
    business: "Corner Deli",
    origin: "https://corner-ops.vercel.app",
  });
  return Response.json({
    ok: Boolean(result.linkToken),
    environment: result.environment,
    oauthEnabled: result.oauthEnabled,
    oauthRedirectUri: result.oauthRedirectUri,
    oauthCallbackToRegister: result.oauthCallbackToRegister,
    oauthWarning: result.oauthWarning,
  });
}
