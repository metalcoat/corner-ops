import {
  requestCustomerEmailCode,
  verifyCustomerEmailCode,
} from "@/lib/customer-email-auth";
import { customerSessionCookie } from "@/lib/customer-ordering-session";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (body.action === "request") {
      await requestCustomerEmailCode(body.email);
      return Response.json({ sent: true });
    }
    if (body.action === "verify") {
      const customerId = await verifyCustomerEmailCode(body.email, body.code);
      return Response.json(
        { authenticated: true },
        {
          headers: {
            "Set-Cookie": customerSessionCookie({
              sessionId: crypto.randomUUID(),
              customerId,
              authenticatedAt: Date.now(),
              expiresAt: Date.now() + 30 * 86400000,
            }),
          },
        },
      );
    }
    return Response.json({ error: "Unknown action." }, { status: 400 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Sign-in failed." },
      { status: 400 },
    );
  }
}
