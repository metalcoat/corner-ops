import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getSql } from "@/lib/db";
import { ensureOrderingTimingSchema } from "@/lib/ordering-timing-schema";
import { canManagePos, orderingActor } from "@/lib/ordering-route-auth";

export const runtime = "nodejs";
const business = "Corner Deli" as const;
const services = new Set(["all", "pickup", "delivery", "dine_in", "online", "phone"]);

async function manager() {
  const actor = await orderingActor(business);
  return actor && canManagePos(actor) ? actor : null;
}

function cleanTime(value: unknown, optional = false): string | null {
  const text = String(value || "").trim();
  if (!text && optional) return null;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(text)) throw new Error("Times must use HH:MM format.");
  return text;
}

function service(value: unknown): string {
  const result = String(value || "all");
  if (!services.has(result)) throw new Error("Unknown ordering service.");
  return result;
}

function timeMinute(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function segments(open: string, close: string): Array<[number, number]> {
  const start = timeMinute(open);
  const end = timeMinute(close);
  return start < end ? [[start, end]] : [[start, 1440], [0, end]];
}

function overlaps(aOpen: string, aClose: string, bOpen: string, bClose: string): boolean {
  return segments(aOpen, aClose).some(([a, b]) => segments(bOpen, bClose).some(([c, d]) => a < d && c < b));
}

async function audit(actor: NonNullable<Awaited<ReturnType<typeof manager>>>, action: string, targetType: string, targetId: string, reason: string, details: unknown) {
  await getSql()`INSERT INTO ordering_operations_audit(id,business,actor_id,actor_role,action,target_type,target_id,reason,details) VALUES(${randomUUID()},${business},${actor.id},${actor.role || "manager"},${action},${targetType},${targetId},${reason},${JSON.stringify(details)}::jsonb)`;
}

export async function GET() {
  const actor = await manager();
  if (!actor) return NextResponse.json({ error: "Manager access required." }, { status: 403 });
  await ensureOrderingTimingSchema();
  const sql = getSql();
  const [settings, weekly, specials, emergency] = await Promise.all([
    sql`SELECT timezone FROM ordering_business_ordering_settings WHERE business=${business}`,
    sql`SELECT id,service_type,weekday,opens_at::text,closes_at::text,ordering_opens_at::text,ordering_cutoff_at::text,active,sort_order FROM ordering_operating_windows WHERE business=${business} ORDER BY service_type,weekday,sort_order,opens_at`,
    sql`SELECT id,business_date,service_type,status,opens_at::text,closes_at::text,ordering_opens_at::text,ordering_cutoff_at::text,label FROM ordering_special_hours WHERE business=${business} AND business_date>=CURRENT_DATE-INTERVAL '30 days' ORDER BY business_date,service_type`,
    sql`SELECT id,service_type,starts_at,ends_at,reason,internal_note,customer_message,created_by,created_at FROM ordering_emergency_closures WHERE business=${business} AND reopened_at IS NULL AND (ends_at IS NULL OR ends_at>=NOW()) ORDER BY starts_at DESC`,
  ]);
  return NextResponse.json({ timezone: settings[0]?.timezone || "America/New_York", weekly, specials, emergency });
}

export async function PATCH(request: Request) {
  const actor = await manager();
  if (!actor) return NextResponse.json({ error: "Manager access required." }, { status: 403 });
  await ensureOrderingTimingSchema();
  const sql = getSql();
  try {
    const body = await request.json() as Record<string, unknown>;
    const action = String(body.action || "");
    if (action === "upsert_weekly") {
      const id = String(body.id || randomUUID());
      const weekday = Number(body.weekday);
      if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw new Error("Weekday must be between 0 and 6.");
      const serviceType = service(body.serviceType);
      const opensAt = cleanTime(body.opensAt)!;
      const closesAt = cleanTime(body.closesAt)!;
      const orderingOpensAt = cleanTime(body.orderingOpensAt, true);
      const orderingCutoffAt = cleanTime(body.orderingCutoffAt, true);
      if (opensAt === closesAt) throw new Error("Opening and closing time cannot be the same.");
      if (Boolean(orderingOpensAt) !== Boolean(orderingCutoffAt)) throw new Error("Ordering start and cutoff must both be set, or both inherit store hours.");
      const peers = await sql`SELECT id,opens_at::text,closes_at::text FROM ordering_operating_windows WHERE business=${business} AND service_type=${serviceType} AND weekday=${weekday} AND active=TRUE AND id<>${id}` as Array<{ id: string; opens_at: string; closes_at: string }>;
      if (peers.some((row) => overlaps(opensAt, closesAt, row.opens_at, row.closes_at))) throw new Error("Operating intervals cannot overlap.");
      await sql`INSERT INTO ordering_operating_windows(id,business,service_type,weekday,opens_at,closes_at,ordering_opens_at,ordering_cutoff_at,active,sort_order,updated_by) VALUES(${id},${business},${serviceType},${weekday},${opensAt}::time,${closesAt}::time,${orderingOpensAt}::time,${orderingCutoffAt}::time,${body.active !== false},${Number(body.sortOrder || 0)},${actor.id}) ON CONFLICT(id) DO UPDATE SET service_type=EXCLUDED.service_type,weekday=EXCLUDED.weekday,opens_at=EXCLUDED.opens_at,closes_at=EXCLUDED.closes_at,ordering_opens_at=EXCLUDED.ordering_opens_at,ordering_cutoff_at=EXCLUDED.ordering_cutoff_at,active=EXCLUDED.active,sort_order=EXCLUDED.sort_order,updated_by=EXCLUDED.updated_by,updated_at=NOW() WHERE ordering_operating_windows.business=${business}`;
      await audit(actor, "ordering_hours_updated", "weekly_window", id, "", { serviceType, weekday });
      return NextResponse.json({ ok: true, id });
    }
    if (action === "delete_weekly") {
      const id = String(body.id || "");
      const rows = await sql`DELETE FROM ordering_operating_windows WHERE id=${id} AND business=${business} RETURNING id`;
      if (!rows.length) throw new Error("Operating interval not found.");
      await audit(actor, "ordering_hours_deleted", "weekly_window", id, String(body.reason || "").trim(), {});
      return NextResponse.json({ ok: true });
    }
    if (action === "upsert_special") {
      const id = String(body.id || randomUUID());
      const businessDate = String(body.businessDate || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) throw new Error("A valid special-hours date is required.");
      const serviceType = service(body.serviceType);
      const status = body.status === "closed" ? "closed" : "custom_hours";
      const opensAt = status === "custom_hours" ? cleanTime(body.opensAt)! : null;
      const closesAt = status === "custom_hours" ? cleanTime(body.closesAt)! : null;
      const orderingOpensAt = status === "custom_hours" ? cleanTime(body.orderingOpensAt, true) : null;
      const orderingCutoffAt = status === "custom_hours" ? cleanTime(body.orderingCutoffAt, true) : null;
      if (opensAt && opensAt === closesAt) throw new Error("Opening and closing time cannot be the same.");
      if (Boolean(orderingOpensAt) !== Boolean(orderingCutoffAt)) throw new Error("Special ordering start and cutoff must both be set, or both inherit special store hours.");
      const label = String(body.label || "").trim();
      await sql`INSERT INTO ordering_special_hours(id,business,business_date,service_type,status,opens_at,closes_at,ordering_opens_at,ordering_cutoff_at,label,updated_by) VALUES(${id},${business},${businessDate}::date,${serviceType},${status},${opensAt}::time,${closesAt}::time,${orderingOpensAt}::time,${orderingCutoffAt}::time,${label},${actor.id}) ON CONFLICT(business,business_date,service_type) DO UPDATE SET status=EXCLUDED.status,opens_at=EXCLUDED.opens_at,closes_at=EXCLUDED.closes_at,ordering_opens_at=EXCLUDED.ordering_opens_at,ordering_cutoff_at=EXCLUDED.ordering_cutoff_at,label=EXCLUDED.label,updated_by=EXCLUDED.updated_by,updated_at=NOW()`;
      await audit(actor, "special_hours_updated", "special_hours", id, label, { businessDate, serviceType, status });
      return NextResponse.json({ ok: true, id });
    }
    if (action === "upsert_menu_availability") {
      const id = String(body.id || randomUUID());
      const targetType = String(body.targetType || "");
      const targetId = String(body.targetId || "");
      if (!new Set(["item", "variant", "modifier_option"]).has(targetType) || !/^[0-9a-f-]{36}$/i.test(targetId)) throw new Error("A stable menu target is required.");
      const days = Array.isArray(body.daysOfWeek) ? body.daysOfWeek.map(Number) : [];
      if (days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) throw new Error("Availability weekdays must be between 0 and 6.");
      const startsAt = cleanTime(body.startsAt, true), endsAt = cleanTime(body.endsAt, true);
      if (Boolean(startsAt) !== Boolean(endsAt)) throw new Error("Availability start and end must both be set or both be blank.");
      await sql`INSERT INTO ordering_menu_availability_rules(id,business,target_type,target_id,enabled,days_of_week,starts_at,ends_at,valid_from,valid_through,updated_by) VALUES(${id},${business},${targetType},${targetId},${body.enabled !== false},${days},${startsAt}::time,${endsAt}::time,${body.validFrom ? String(body.validFrom) : null}::date,${body.validThrough ? String(body.validThrough) : null}::date,${actor.id}) ON CONFLICT(business,target_type,target_id) DO UPDATE SET enabled=EXCLUDED.enabled,days_of_week=EXCLUDED.days_of_week,starts_at=EXCLUDED.starts_at,ends_at=EXCLUDED.ends_at,valid_from=EXCLUDED.valid_from,valid_through=EXCLUDED.valid_through,updated_by=EXCLUDED.updated_by,updated_at=NOW()`;
      await audit(actor, "menu_availability_updated", targetType, targetId, String(body.reason || "").trim(), { days, startsAt, endsAt });
      return NextResponse.json({ ok: true, id });
    }
    if (action === "emergency_close") {
      const id = randomUUID();
      const serviceType = service(body.serviceType);
      const reason = String(body.reason || "").trim();
      if (!reason) throw new Error("An emergency closure reason is required.");
      const startsAt = body.startsAt ? new Date(String(body.startsAt)) : new Date();
      const endsAt = body.endsAt ? new Date(String(body.endsAt)) : null;
      if (Number.isNaN(startsAt.getTime()) || (endsAt && (Number.isNaN(endsAt.getTime()) || endsAt <= startsAt))) throw new Error("Emergency closure times are invalid.");
      await sql`INSERT INTO ordering_emergency_closures(id,business,service_type,starts_at,ends_at,reason,internal_note,customer_message,created_by) VALUES(${id},${business},${serviceType},${startsAt},${endsAt},${reason},${String(body.internalNote || "").trim()},${String(body.customerMessage || "").trim()},${actor.id})`;
      await sql`UPDATE ordering_orders SET affected_by_closure_id=${id},operational_follow_up_reason=${`Emergency closure: ${reason}`},updated_at=NOW() WHERE business=${business} AND timing_mode='future' AND scheduled_for>=${startsAt} AND (${endsAt}::timestamptz IS NULL OR scheduled_for<=${endsAt}) AND status NOT IN ('completed','cancelled') AND (${serviceType}='all' OR CASE WHEN service_type IN ('no_contact_delivery') THEN 'delivery' WHEN service_type IN ('bar') THEN 'dine_in' ELSE service_type END=${serviceType})`;
      await audit(actor, "emergency_closed", "emergency_closure", id, reason, { serviceType, startsAt, endsAt });
      return NextResponse.json({ ok: true, id });
    }
    if (action === "reopen") {
      const id = String(body.id || "");
      const reason = String(body.reason || "").trim();
      const rows = await sql`UPDATE ordering_emergency_closures SET reopened_by=${actor.id},reopened_at=NOW() WHERE id=${id} AND business=${business} AND reopened_at IS NULL RETURNING id`;
      if (!rows.length) throw new Error("Active emergency closure not found.");
      await audit(actor, "emergency_reopened", "emergency_closure", id, reason, {});
      return NextResponse.json({ ok: true });
    }
    throw new Error("Unknown Store Operations action.");
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not update Store Operations." }, { status: 400 });
  }
}
