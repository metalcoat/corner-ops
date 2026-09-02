import { after } from "next/server";
import { canAccessBusiness, getSession } from "@/lib/auth";
import { normalizePosition, roleGroupForPosition } from "@/lib/business-positions";
import { getSql } from "@/lib/db";
import { listDirectoryEmployees } from "@/lib/employee-directory-admin";
import { apiError, ConflictError, unauthorized } from "@/lib/http";
import { createEmployee, updateEmployee } from "@/lib/operations";
import { updateScheduleShiftSafely } from "@/lib/schedule-actions";
import { createScheduleDraftWithMeals } from "@/lib/schedule-draft";
import { ensureScheduleMealSchema } from "@/lib/schedule-meal-storage";
import { publishValidatedScheduleWeek } from "@/lib/schedule-publish-validation";
import { processSchedulePublicationDeliveries } from "@/lib/schedule-publication-delivery";
import { copyScheduleWeekToTarget } from "@/lib/schedule-week-copy";
import { sendStaffNotification } from "@/lib/staff-notifications";
import type { Business } from "@/lib/types";
import {
  reviewShiftRequest,
  reviewTimeCorrection,
  reviewTimeOff,
  workforceDashboard,
} from "@/lib/workforce";

export const runtime = "nodejs";
export const maxDuration = 60;

function businessFrom(value: unknown): Business {
  if (value === "Corner Deli" || value === "Tiki") return value;
  throw new Error("Unknown business.");
}

function transientSchemaRace(error: unknown): boolean {
  const candidate = error as { code?: unknown; message?: unknown };
  return candidate?.code === "XX000"
    && String(candidate.message || "").toLowerCase().includes("tuple concurrently updated");
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function actionError(error: unknown, fallback: string): Response {
  const candidate = error as { code?: unknown };
  if (candidate?.code || error instanceof ConflictError) return apiError(error);
  return Response.json({ error: error instanceof Error ? error.message : fallback }, { status: 400 });
}

async function buildWorkforcePayload(business: Business) {
  await ensureScheduleMealSchema();
  const directory = await listDirectoryEmployees(business);
  const dashboard = await workforceDashboard(business);
  const mealRows = await getSql()`
    SELECT id, meal_break_start, meal_break_minutes,
      extra_meal_break_start, extra_meal_break_minutes
    FROM schedule_shifts
    WHERE business = ${business}
      AND status <> 'Cancelled'
      AND starts_at >= NOW() - INTERVAL '21 days'
      AND starts_at < NOW() + INTERVAL '120 days'
  ` as unknown as Array<{
    id: string;
    meal_break_start: string | null;
    meal_break_minutes: number;
    extra_meal_break_start: string | null;
    extra_meal_break_minutes: number;
  }>;
  const mealByShiftId = new Map(mealRows.map((row) => [String(row.id), row]));
  const contactById = new Map(directory.map((employee) => [employee.id, employee]));

  return {
    ...dashboard,
    employees: dashboard.employees.map((employee) => ({
      ...employee,
      email: contactById.get(employee.id)?.email || "",
      scheduleColor: contactById.get(employee.id)?.scheduleColor || "#64748B",
      avatarSet: contactById.get(employee.id)?.avatarSet || false,
    })),
    shifts: dashboard.shifts.map((shift) => {
      const meal = mealByShiftId.get(shift.id);
      return {
        ...shift,
        mealBreakStart: meal?.meal_break_start ? String(meal.meal_break_start) : null,
        mealBreakMinutes: Number(meal?.meal_break_minutes || 0),
        extraMealBreakStart: meal?.extra_meal_break_start ? String(meal.extra_meal_break_start) : null,
        extraMealBreakMinutes: Number(meal?.extra_meal_break_minutes || 0),
        employeeColor: shift.employeeId ? contactById.get(shift.employeeId)?.scheduleColor || "#64748B" : "#64748B",
        employeeAvatarSet: shift.employeeId ? contactById.get(shift.employeeId)?.avatarSet || false : false,
      };
    }),
    messages: (dashboard.messages as Array<Record<string, unknown>>).map((message) => {
      const senderId = message.sender_employee_id ? String(message.sender_employee_id) : "";
      const sender = senderId ? contactById.get(senderId) : undefined;
      return {
        ...message,
        sender_schedule_color: sender?.scheduleColor || "#64748B",
        sender_avatar_set: sender?.avatarSet || false,
      };
    }),
  };
}

async function loadWorkforcePayload(business: Business) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await buildWorkforcePayload(business);
    } catch (error) {
      lastError = error;
      if (!transientSchemaRace(error) || attempt === 2) throw error;
      await delay(100 * (attempt + 1) + Math.floor(Math.random() * 100));
    }
  }
  throw lastError;
}

export async function GET(request: Request) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    const business = businessFrom(new URL(request.url).searchParams.get("business"));
    if (!canAccessBusiness(session, business)) return Response.json({ error: "Business access denied." }, { status: 403 });
    return Response.json(await loadWorkforcePayload(business));
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    const body = await request.json() as Record<string, unknown>;
    const business = businessFrom(body.business);
    if (!canAccessBusiness(session, business)) return Response.json({ error: "Business access denied." }, { status: 403 });
    const action = String(body.action || "");

    if (action === "employee-create") {
      const position = normalizePosition(business, body.position);
      const requestedRole = String(body.roleGroup || "In-House");
      if (requestedRole !== "Driver" && requestedRole !== "In-House" && requestedRole !== "Ignore") throw new Error("Invalid employee role group.");
      const roleGroup = requestedRole === "Ignore" ? "Ignore" : roleGroupForPosition(business, position);
      return Response.json(await createEmployee({
        business,
        name: String(body.name || ""),
        pin: String(body.pin || ""),
        position,
        roleGroup,
        countsForTips: body.countsForTips !== false,
        hourlyRate: Number(body.hourlyRate || 0),
        tippedRate: Number(body.tippedRate || 0),
      }), { status: 201 });
    }

    if (action === "employee-update") {
      const position = body.position === undefined ? undefined : normalizePosition(business, body.position);
      const requestedRole = body.roleGroup ? String(body.roleGroup) : undefined;
      if (requestedRole && requestedRole !== "Driver" && requestedRole !== "In-House" && requestedRole !== "Ignore") throw new Error("Invalid employee role group.");
      const roleGroup = requestedRole === "Ignore"
        ? "Ignore"
        : position
          ? roleGroupForPosition(business, position)
          : requestedRole as "Driver" | "In-House" | undefined;
      return Response.json(await updateEmployee({
        id: String(body.id || ""),
        active: body.active === undefined ? undefined : body.active === true,
        pin: body.pin ? String(body.pin) : undefined,
        name: body.name === undefined ? undefined : String(body.name || ""),
        position,
        roleGroup,
        countsForTips: body.countsForTips === undefined ? undefined : body.countsForTips === true,
        hourlyRate: body.hourlyRate === undefined ? undefined : Number(body.hourlyRate || 0),
        tippedRate: body.tippedRate === undefined ? undefined : Number(body.tippedRate || 0),
      }));
    }

    if (action === "shift-create") {
      try {
        return Response.json(await createScheduleDraftWithMeals({
          business,
          employeeId: body.employeeId ? String(body.employeeId) : null,
          position: normalizePosition(business, body.position),
          startsAt: String(body.startsAt || ""),
          endsAt: String(body.endsAt || ""),
          mealBreakStart: body.mealBreakStart ? String(body.mealBreakStart) : null,
          mealBreakMinutes: Number(body.mealBreakMinutes || 0),
          extraMealBreakStart: body.extraMealBreakStart ? String(body.extraMealBreakStart) : null,
          extraMealBreakMinutes: Number(body.extraMealBreakMinutes || 0),
          notes: body.notes ? String(body.notes) : "",
          actor: session.displayName,
          acknowledgePendingTimeOff: body.acknowledgePendingTimeOff === true,
        }), { status: 201 });
      } catch (error) {
        return actionError(error, "The shift could not be created.");
      }
    }

    if (action === "shift-update") {
      try {
        const requestedStatus = body.status ? String(body.status) : undefined;
        if (requestedStatus && requestedStatus !== "Draft" && requestedStatus !== "Published" && requestedStatus !== "Open" && requestedStatus !== "Cancelled") {
          throw new Error("Invalid shift status.");
        }
        const status = requestedStatus;
        return Response.json(await updateScheduleShiftSafely({
          id: String(body.id || ""),
          business,
          employeeId: body.employeeId === undefined ? undefined : body.employeeId ? String(body.employeeId) : null,
          position: body.position === undefined ? undefined : normalizePosition(business, body.position),
          startsAt: body.startsAt === undefined ? undefined : String(body.startsAt || ""),
          endsAt: body.endsAt === undefined ? undefined : String(body.endsAt || ""),
          mealBreakStart: body.mealBreakStart === undefined ? undefined : body.mealBreakStart ? String(body.mealBreakStart) : null,
          mealBreakMinutes: body.mealBreakMinutes === undefined ? undefined : Number(body.mealBreakMinutes || 0),
          extraMealBreakStart: body.extraMealBreakStart === undefined ? undefined : body.extraMealBreakStart ? String(body.extraMealBreakStart) : null,
          extraMealBreakMinutes: body.extraMealBreakMinutes === undefined ? undefined : Number(body.extraMealBreakMinutes || 0),
          status: status as "Draft" | "Published" | "Open" | "Cancelled" | undefined,
          notes: body.notes === undefined ? undefined : String(body.notes || ""),
          acknowledgePendingTimeOff: body.acknowledgePendingTimeOff === true,
          expectedUpdatedAt: body.expectedUpdatedAt ? String(body.expectedUpdatedAt) : null,
        }));
      } catch (error) {
        return actionError(error, "The shift could not be updated.");
      }
    }

    if (action === "week-publish") {
      try {
        const result = await publishValidatedScheduleWeek({
          business,
          weekStart: String(body.weekStart || ""),
          actor: session.displayName,
          allowOvertime: body.allowOvertime === true,
        });
        if (result.publicationId) {
          after(() => processSchedulePublicationDeliveries({ publicationId: String(result.publicationId), limit: 30 }).catch((error) => {
            console.error("[schedule-delivery] post-response worker failed", error);
          }));
        }
        return Response.json(result);
      } catch (error) {
        return actionError(error, "The schedule could not be published.");
      }
    }

    if (action === "week-copy") {
      try {
        return Response.json(await copyScheduleWeekToTarget({
          business,
          sourceWeekStart: String(body.sourceWeekStart || ""),
          targetWeekStart: String(body.targetWeekStart || ""),
          actor: session.displayName,
        }));
      } catch (error) {
        return actionError(error, "The schedule week could not be copied.");
      }
    }

    if (action === "message-send") {
      return Response.json(await sendStaffNotification({
        business,
        recipientEmployeeId: body.recipientEmployeeId ? String(body.recipientEmployeeId) : null,
        body: String(body.body || ""),
        actor: session.displayName,
        sendSms: body.sendSms === true,
      }));
    }

    if (action === "shift-request-review") {
      return Response.json(await reviewShiftRequest({
        id: String(body.id || ""),
        business,
        approve: body.approve === true,
        managerNote: body.managerNote ? String(body.managerNote) : "",
        actor: session.displayName,
      }));
    }

    if (action === "time-off-review") {
      return Response.json(await reviewTimeOff({
        id: String(body.id || ""),
        business,
        approve: body.approve === true,
        managerNote: body.managerNote ? String(body.managerNote) : "",
        actor: session.displayName,
      }));
    }

    if (action === "time-correction-review") {
      return Response.json(await reviewTimeCorrection({
        id: String(body.id || ""),
        business,
        approve: body.approve === true,
        managerNote: body.managerNote ? String(body.managerNote) : "",
        actor: session.displayName,
      }));
    }

    return Response.json({ error: "Unknown workforce action." }, { status: 400 });
  } catch (error) {
    return apiError(error);
  }
}
