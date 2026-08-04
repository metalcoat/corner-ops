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

type AudiencePreference = "owner" | "employee" | "";

async function currentActor(preference: AudiencePreference = ""): Promise<PushActor | null> {
  if (preference === "employee") {
    const employee = await getEmployeeSession();
    if (employee) return { type: "employee", employeeId: employee.employeeId, business: employee.business };
  }
  const owner = await getSession();
  if (owner) return { type: "owner", email: owner.email };
  const employee = await getEmployeeSession();
  if (employee) return { type: "employee", employeeId: employee.employeeId, business: employee.business };
  return null;
}

function preference(value: unknown): AudiencePreference {
  return value === "employee" || value === "owner" ? value : "";
}

export async function GET(request: Request) {
  try {
    const actor = await currentActor(preference(new URL(request.url).searchParams.get("audience")));
    if (!actor) return unauthorized();
    return Response.json(await pushStatus(actor));
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const actor = await currentActor(preference(body.audience));
    if (!actor) return unauthorized();
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
