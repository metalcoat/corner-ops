import { randomUUID } from "node:crypto";
import { getSql } from "@/lib/db";
import { ensureOrderingPosSchema } from "@/lib/ordering-pos-schema";
import type { OrderingActor } from "@/lib/ordering-route-auth";
import { STALE_DRAFT_SNOOZE_MINUTES, draftAgeLabel, parseStaleDraftSettings, stationShowsStaleDrafts, type StaleDraftSettings } from "@/lib/stale-draft-rules";

const business = "Corner Deli" as const;

export async function getStaleDraftSettings(): Promise<StaleDraftSettings> {
  await ensureOrderingPosSchema();
  const row = (await getSql()`SELECT stale_draft_alert_minutes,stale_draft_alert_stations FROM ordering_business_settings WHERE business=${business}`)[0];
  return { minutes: Number(row?.stale_draft_alert_minutes ?? 10), stations: (row?.stale_draft_alert_stations as string[] | undefined) ?? ["deli-back-1"] };
}

export async function saveStaleDraftSettings(input: { minutes?: unknown; stations?: unknown }, actor: OrderingActor) {
  const settings = parseStaleDraftSettings(input), sql = getSql();
  await sql`UPDATE ordering_business_settings SET stale_draft_alert_minutes=${settings.minutes},stale_draft_alert_stations=${settings.stations},updated_by=${actor.id},updated_at=NOW() WHERE business=${business}`;
  await sql`INSERT INTO ordering_pos_audit_events(id,business,event_type,employee_id,actor,details) VALUES(${randomUUID()},${business},'stale_draft_settings_changed',${actor.id},${actor.name},${JSON.stringify(settings)}::jsonb)`;
  return settings;
}

export async function staleDraftStations() {
  const rows = await getSql()`SELECT station_key,name FROM ordering_payment_stations WHERE business=${business} AND active=TRUE ORDER BY name`;
  return rows.map((row) => ({ key: String(row.station_key), name: String(row.name) }));
}

/**
 * Orders staff rang on a POS and never sent, idle for the set minutes. Web carts and AI calls are excluded
 * (source), and so are sent orders reopened for changes (submitted_at): those return to the kitchen by themselves.
 */
export async function listStaleDrafts(stationKey: string) {
  const settings = await getStaleDraftSettings();
  if (!stationShowsStaleDrafts(settings, stationKey)) return { enabled: false, drafts: [] };
  const now = new Date();
  const rows = await getSql()`
    SELECT o.id,o.display_number,o.service_type,o.total_cents,o.created_at,o.first_name_snapshot,o.last_name_snapshot,o.phone_snapshot,
      COALESCE(employee.name,'Staff') started_by,COALESCE(station.name,'') station_name,
      (SELECT string_agg(GREATEST(i.quantity-COALESCE(i.cancelled_quantity,0),0)||'× '||i.item_name_snapshot,', ' ORDER BY i.sort_order,i.created_at) FROM ordering_order_items i WHERE i.order_id=o.id AND i.quantity>COALESCE(i.cancelled_quantity,0)) items
    FROM ordering_orders o
    LEFT JOIN employees employee ON employee.id::text=o.created_by
    LEFT JOIN ordering_payment_stations station ON station.business=o.business AND station.station_key=o.created_station
    WHERE o.business=${business} AND o.source='pos' AND o.status='draft' AND o.voided_at IS NULL AND o.submitted_at IS NULL AND o.service_type<>'bar'
      AND o.updated_at<NOW()-make_interval(mins=>${settings.minutes})
      AND (o.draft_alert_snoozed_until IS NULL OR o.draft_alert_snoozed_until<=NOW())
    ORDER BY o.created_at LIMIT 25`;
  return {
    enabled: true,
    drafts: rows.map((row) => ({
      id: String(row.id), displayNumber: String(row.display_number), serviceType: String(row.service_type), totalCents: Number(row.total_cents),
      customer: `${row.first_name_snapshot || ""} ${row.last_name_snapshot || ""}`.trim() || String(row.phone_snapshot || ""),
      items: String(row.items || "No items"), startedBy: String(row.started_by), station: String(row.station_name || ""), age: draftAgeLabel(String(row.created_at), now),
    })),
  };
}

export async function snoozeStaleDraft(orderId: string, actor: OrderingActor) {
  const sql = getSql();
  const rows = await sql`UPDATE ordering_orders SET draft_alert_snoozed_until=NOW()+make_interval(mins=>${STALE_DRAFT_SNOOZE_MINUTES}) WHERE id=${orderId} AND business=${business} AND status='draft' RETURNING id`;
  if (rows.length) await sql`INSERT INTO ordering_pos_audit_events(id,business,event_type,order_id,employee_id,actor,details) VALUES(${randomUUID()},${business},'stale_draft_snoozed',${orderId},${actor.id},${actor.name},${JSON.stringify({ minutes: STALE_DRAFT_SNOOZE_MINUTES })}::jsonb)`;
  return { snoozed: rows.length > 0 };
}
