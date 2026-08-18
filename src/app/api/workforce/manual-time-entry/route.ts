import { canAccessBusiness, getSession } from "@/lib/auth";
import { normalizePosition, roleGroupForPosition } from "@/lib/business-positions";
import { apiError, unauthorized } from "@/lib/http";
import { createManualTimeEntry } from "@/lib/manual-time-entry";
import type { Business } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TIME_ZONE = "America/New_York";

function businessFrom(value: unknown): Business {
  if (value === "Corner Deli" || value === "Tiki") return value;
  throw new Error("Unknown business.");
}

function offsetMilliseconds(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return Date.UTC(
    Number(values.year), Number(values.month) - 1, Number(values.day),
    Number(values.hour), Number(values.minute), Number(values.second),
  ) - date.getTime();
}

function easternWallToIso(dateText: string, timeText: string) {
  const dateMatch = dateText.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const timeMatch = timeText.match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!dateMatch || !timeMatch) throw new Error("Enter a valid Eastern date and time.");

  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const second = Number(timeMatch[3] || 0);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    throw new Error("Enter a valid Eastern date and time.");
  }

  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  let timestamp = wall;
  for (let index = 0; index < 3; index += 1) {
    timestamp = wall - offsetMilliseconds(new Date(timestamp));
  }
  return new Date(timestamp).toISOString();
}

function nextDate(dateText: string) {
  const [year, month, day] = dateText.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + 1, 12));
  return date.toISOString().slice(0, 10);
}

function submittedTimes(body: Record<string, unknown>) {
  const date = String(body.date || "").trim();
  const clockInWall = String(body.clockInWall || "").trim();
  const clockOutWall = String(body.clockOutWall || "").trim();

  if (date && clockInWall && clockOutWall) {
    const start = easternWallToIso(date, clockInWall);
    let endDate = date;
    if (clockOutWall <= clockInWall) endDate = nextDate(date);
    const end = easternWallToIso(endDate, clockOutWall);
    return { clockIn: start, clockOut: end };
  }

  // Backward compatibility for any older client still posting ISO timestamps.
  return {
    clockIn: String(body.clockIn || ""),
    clockOut: String(body.clockOut || ""),
  };
}

export async function POST(request: Request) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();

    const body = await request.json() as Record<string, unknown>;
    const business = businessFrom(body.business);
    if (!canAccessBusiness(session, business)) {
      return Response.json({ error: "Business access denied." }, { status: 403 });
    }

    const position = normalizePosition(business, body.position);
    const times = submittedTimes(body);
    return Response.json(await createManualTimeEntry({
      business,
      employeeId: String(body.employeeId || ""),
      position,
      roleGroup: roleGroupForPosition(business, position),
      clockIn: times.clockIn,
      clockOut: times.clockOut,
      note: String(body.note || ""),
      actor: session.displayName,
    }), { status: 201 });
  } catch (error) {
    const candidate = error as { code?: unknown };
    if (candidate?.code) return apiError(error);
    return Response.json({ error: error instanceof Error ? error.message : "The missing shift could not be created." }, { status: 400 });
  }
}
