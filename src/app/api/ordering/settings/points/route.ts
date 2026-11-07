import { randomUUID } from "node:crypto";
import { isoJson } from "@/lib/timestamp-values";
import { canManagePos, orderingActor } from "@/lib/ordering-route-auth";
import { getSql } from "@/lib/db";
import { pointsRewards, pointsSettings } from "@/lib/ordering-points";

async function manager() {
  const actor = await orderingActor("Corner Deli");
  return actor && canManagePos(actor) ? actor : null;
}
const time = (value: unknown, label: string) => {
  const text = String(value || "");
  if (!/^\d{2}:\d{2}$/.test(text)) throw new Error(`${label} must look like 10:30.`);
  return text;
};
const number = (value: unknown, label: string, min: number) => {
  const result = Number(value);
  if (!Number.isFinite(result) || result < min) throw new Error(`${label} is invalid.`);
  return result;
};

export async function GET() {
  if (!(await manager())) return isoJson({ error: "Manager access required." }, { status: 403 });
  const rewards = await pointsRewards("Corner Deli", true);
  return isoJson({ settings: await pointsSettings("Corner Deli"), rewards: rewards.map((row) => ({ id: row.id, label: row.label, points: row.points, kind: row.kind, active: row.active })) });
}

// Managers turn points on/off, set earn rates, the bonus window and expiry, and each reward's points.
export async function PUT(request: Request) {
  const actor = await manager();
  if (!actor) return isoJson({ error: "Manager access required." }, { status: 403 });
  try {
    const body = (await request.json()) as Record<string, unknown>, sql = getSql();
    const before = await pointsSettings("Corner Deli");
    const settings = body.settings as Record<string, unknown> | undefined;
    if (settings) {
      const days = Array.isArray(settings.bonusDays) ? [...new Set(settings.bonusDays.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))] : before.bonusDays;
      await sql`INSERT INTO ordering_points_settings(business,active,online_rate,store_rate,staff_phone_orders_earn,bonus_multiplier,bonus_days,bonus_start,bonus_end,expiry_months,updated_at,updated_by)
        VALUES('Corner Deli',${Boolean(settings.active)},${number(settings.onlineRate, "Online points per $1", 0)},${number(settings.storeRate, "In-store points per $1", 0)},${settings.staffPhoneOrdersEarn !== false},${number(settings.bonusMultiplier, "Bonus multiplier", 1)},${days},${time(settings.bonusStart, "Bonus start")},${time(settings.bonusEnd, "Bonus end")},${Math.trunc(number(settings.expiryMonths, "Expiry months", 0))},NOW(),${actor.id})
        ON CONFLICT(business) DO UPDATE SET active=EXCLUDED.active,online_rate=EXCLUDED.online_rate,store_rate=EXCLUDED.store_rate,staff_phone_orders_earn=EXCLUDED.staff_phone_orders_earn,bonus_multiplier=EXCLUDED.bonus_multiplier,bonus_days=EXCLUDED.bonus_days,bonus_start=EXCLUDED.bonus_start,bonus_end=EXCLUDED.bonus_end,expiry_months=EXCLUDED.expiry_months,updated_at=NOW(),updated_by=EXCLUDED.updated_by`;
    }
    for (const raw of Array.isArray(body.rewards) ? body.rewards : []) {
      const reward = raw as Record<string, unknown>;
      await sql`UPDATE ordering_points_rewards SET points=${Math.trunc(number(reward.points, "Reward points", 1))},active=${reward.active !== false},updated_at=NOW(),updated_by=${actor.id} WHERE id=${String(reward.id || "")} AND business='Corner Deli'`;
    }
    await sql`INSERT INTO ordering_pos_audit_events(id,business,event_type,actor,reason,details) VALUES(${randomUUID()},'Corner Deli','points_configuration_changed',${actor.email || actor.id},'',${JSON.stringify({ before, settings: settings || null, rewards: body.rewards || [] })}::jsonb)`;
    return GET();
  } catch (error) {
    return isoJson({ error: error instanceof Error ? error.message : "Could not save points settings." }, { status: 400 });
  }
}
