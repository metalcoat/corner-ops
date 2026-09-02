import type { Business } from "@/lib/types";

const TIME_ZONE = "America/New_York";

export type ScheduleSmsShift = {
  employee_id: string | null;
  position: string;
  starts_at: string;
  ends_at: string;
};

function clean(value: unknown, max = 500): string {
  return String(value ?? "").trim().slice(0, max);
}

function compactTime(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value))
    .replace(":00", "")
    .replace(" AM", "a")
    .replace(" PM", "p");
}

function compactShift(shift: ScheduleSmsShift): string {
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    weekday: "short",
  }).format(new Date(shift.starts_at));
  return `${day} ${compactTime(shift.starts_at)}-${compactTime(shift.ends_at)} ${clean(shift.position, 40) || "Shift"}`;
}

export function scheduleSmsText(input: {
  business: Business;
  mode: "initial" | "changes" | "resend";
  shifts: ScheduleSmsShift[];
  hubUrl?: string;
}) {
  const verb = input.mode === "initial" ? "published" : input.mode === "resend" ? "resent" : "updated";
  const schedule = input.shifts.length
    ? input.shifts.map(compactShift).join("; ")
    : "No shifts assigned this week.";
  return [
    `${input.business} schedule ${verb}: ${schedule}`,
    input.hubUrl ? `View/current changes: ${input.hubUrl}` : "",
    "Reply STOP to opt out.",
  ].filter(Boolean).join(" ");
}
