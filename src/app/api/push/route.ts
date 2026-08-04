import { getSession } from "@/lib/auth";
import { getEmployeeSession } from "@/lib/employee-auth";
import { apiError, unauthorized } from "@/lib/http";
import {
  pushStatus,
  removePushSubscription,
  savePushSubscription,
  sendTestPush,
  type PushActor,
  type PushSubscriptionInput,
} from "@/lib/push-notifications";

export const runtime = "nodejs";
export const maxDuration = 60;

async function currentActor(): Promise<PushActor | null> {
  const owner = await getSession();
  if (owner) return { type: "owner", email: owner.email };
  const employee = await getEmployeeSession();
  if (employee) return {
    type: "employee",
    employeeId: employee.employeeId,
    business: employee.business,
  };
  return null;
}

export async function GET() {
  try {
    const actor = await currentActor();
    if (!actor) return unauthorized();
    return Response.json(await pushStatus(actor));
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = await currentActor();
    if (!actor) return unauthorized();
    const body = await request.json() as Record<string, unknown>;
    const action = String(body.action || "subscribe");

    if (action === "subscribe") {
      const subscription = body.subscription as PushSubscriptionInput | undefined;
      if (!subscription) return Response.json({ error: "Push subscription is required." }, { status: 400 });
      return Response.json(await savePushSubscription(actor, {
        ...subscription,
        userAgent: String(body.userAgent || ""),
        deviceLabel: String(body.deviceLabel || ""),
      }), { status: 201 });
    }

    if (action === "unsubscribe") {
      return Response.json(await removePushSubscription(actor, String(body.endpoint || "")));
    }

    if (action === "test") {
      return Response.json(await sendTestPush(actor));
    }

    return Response.json({ error: "Unknown push-notification action." }, { status: 400 });
  } catch (error) {
    return apiError(error);
  }
}
