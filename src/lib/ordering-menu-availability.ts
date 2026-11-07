import { getSql } from "@/lib/db";
import type { OrderingBusiness } from "@/lib/ordering-core";
import { ensureOrderingTimingSchema } from "@/lib/ordering-timing-schema";

type TargetType = "item" | "variant" | "modifier_option";
type Rule = { days_of_week: number[]; starts_at: string | null; ends_at: string | null; valid_from: string | Date | null; valid_through: string | Date | null };

function local(at: Date) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" }).formatToParts(at);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { date: `${values.year}-${values.month}-${values.day}`, weekday: weekdays[values.weekday] ?? 0, minute: Number(values.hour) * 60 + Number(values.minute) };
}

function minute(value: string): number { const [hour, minutes] = value.split(":").map(Number); return hour * 60 + minutes; }
function date(value: string | Date | null): string | null { return value instanceof Date ? value.toISOString().slice(0, 10) : value ? String(value).slice(0, 10) : null; }

export function menuAvailabilityRuleAllows(rule: Rule, at: Date): boolean {
  const current = local(at);
  const from = date(rule.valid_from), through = date(rule.valid_through);
  if (from && current.date < from) return false;
  if (through && current.date > through) return false;
  if (rule.days_of_week.length && !rule.days_of_week.includes(current.weekday)) return false;
  if (rule.starts_at && rule.ends_at) {
    const start = minute(rule.starts_at), end = minute(rule.ends_at);
    if (start < end ? current.minute < start || current.minute > end : current.minute < start && current.minute > end) return false;
  }
  return true;
}

export async function assertMenuTargetsAvailable(input: { business: OrderingBusiness; at: Date; targets: Array<{ type: TargetType; id: string; label: string }> }) {
  if (!input.targets.length) return;
  await ensureOrderingTimingSchema();
  const sql = getSql();
  for (const target of input.targets) {
    const rows = await sql`SELECT days_of_week,starts_at::text,ends_at::text,valid_from,valid_through FROM ordering_menu_availability_rules WHERE business=${input.business} AND target_type=${target.type} AND target_id=${target.id} AND enabled=TRUE LIMIT 1` as Rule[];
    if (rows[0] && !menuAvailabilityRuleAllows(rows[0], input.at)) throw new Error(`${target.label} is not available for the scheduled fulfillment time.`);
  }
}

export async function applyScheduledMenuAvailability<T extends Array<Record<string, any>>>(business: OrderingBusiness, at: Date, categories: T): Promise<T> {
  await ensureOrderingTimingSchema();
  const rules = await getSql()`SELECT target_type,target_id::text,days_of_week,starts_at::text,ends_at::text,valid_from,valid_through FROM ordering_menu_availability_rules WHERE business=${business} AND enabled=TRUE` as Array<Rule & { target_type: TargetType; target_id: string }>;
  const allowed = new Map(rules.map((rule) => [`${rule.target_type}:${rule.target_id}`, menuAvailabilityRuleAllows(rule, at)]));
  return categories.map((category) => ({
    ...category,
    items: (category.items || []).map((item: Record<string, any>) => ({
      ...item,
      available: item.available !== false && allowed.get(`item:${item.id}`) !== false,
      variants: (item.variants || []).map((variant: Record<string, any>) => ({ ...variant, available: variant.available !== false && allowed.get(`variant:${variant.id}`) !== false })),
      modifiers: (item.modifiers || []).map((group: Record<string, any>) => ({ ...group, options: (group.options || []).map((option: Record<string, any>) => ({ ...option, available: option.available !== false && allowed.get(`modifier_option:${option.id}`) !== false })) })),
    })),
  })) as unknown as T;
}
