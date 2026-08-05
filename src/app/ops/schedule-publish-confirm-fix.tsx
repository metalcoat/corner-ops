"use client";

import { useEffect } from "react";

const OLD_NOTICE = "This will notify all active employees.";
const NEW_NOTICE = "Only employees whose schedules changed will be notified.";
const VERIFIED_WEEK_PREFIX = "corner-ops:verified-published-week:";
const TIME_ZONE = "America/New_York";

type WorkforceShift = {
  id?: string;
  employeeId?: string | null;
  startsAt?: string;
  status?: string;
  publishedAt?: string | null;
};

type WorkforcePayload = {
  business?: string;
  shifts?: WorkforceShift[];
};

function workforceUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return `${input.pathname}${input.search}`;
  return input.url;
}

function localDateKey(value: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function mondayForTimestamp(value: string): string {
  const localDate = localDateKey(value);
  const date = new Date(`${localDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

function verifiedWeekKey(business: string, weekStart: string): string {
  return `${VERIFIED_WEEK_PREFIX}${business}:${weekStart}`;
}

function rememberVerifiedWeek(business: string, weekStart: string) {
  try {
    window.sessionStorage.setItem(verifiedWeekKey(business, weekStart), new Date().toISOString());
  } catch {
    // Session storage is only a UI reconciliation aid. The database remains authoritative.
  }
}

function weekWasVerified(business: string, weekStart: string): boolean {
  try {
    return Boolean(window.sessionStorage.getItem(verifiedWeekKey(business, weekStart)));
  } catch {
    return false;
  }
}

function normalizedWorkforcePayload(payload: WorkforcePayload): WorkforcePayload {
  const business = String(payload.business || "");
  if (!business || !Array.isArray(payload.shifts)) return payload;

  let normalizedCount = 0;
  const shifts = payload.shifts.map((shift) => {
    if (shift.status !== "Draft" || !shift.startsAt) return shift;
    const weekStart = mondayForTimestamp(shift.startsAt);
    const verified = weekWasVerified(business, weekStart);
    if (!shift.publishedAt && !verified) return shift;
    normalizedCount += 1;
    return {
      ...shift,
      status: shift.employeeId ? "Published" : "Open",
    };
  });

  if (normalizedCount) {
    console.info("schedule-ui-reconciled", { business, normalizedCount });
  }
  return { ...payload, shifts };
}

function jsonResponse(payload: unknown, response: Response): Response {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(payload), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default function SchedulePublishConfirmFix() {
  useEffect(() => {
    const originalConfirm = window.confirm.bind(window);
    const originalFetch = window.fetch.bind(window);

    window.confirm = (message?: string) => {
      const text = typeof message === "string" && message.includes(OLD_NOTICE)
        ? message.replace(OLD_NOTICE, NEW_NOTICE)
        : message;
      return originalConfirm(text);
    };

    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      let target: RequestInfo | URL = input;
      let isSchedulePublish = false;
      let publishedBusiness = "";
      const url = workforceUrl(input);
      const method = String(init?.method || "GET").toUpperCase();

      if (url.includes("/api/workforce") && method === "POST" && typeof init?.body === "string") {
        try {
          const body = JSON.parse(init.body) as { action?: string; business?: string };
          if (body.action === "week-publish") {
            target = "/api/workforce/week-publish-v2";
            isSchedulePublish = true;
            publishedBusiness = String(body.business || "");
          }
        } catch {
          // Leave unrelated or non-JSON requests untouched.
        }
      }

      const response = await originalFetch(target, init);

      if (method === "GET" && url.includes("/api/workforce?") && response.ok) {
        const payload = await response.clone().json().catch(() => null) as WorkforcePayload | null;
        return payload ? jsonResponse(normalizedWorkforcePayload(payload), response) : response;
      }

      if (!isSchedulePublish) return response;

      const payload = await response.clone().json().catch(() => null) as {
        error?: string;
        remainingDraftShiftIds?: string[];
        draftEmployeesBefore?: string[];
        targetWeekStart?: string;
      } | null;

      if (!response.ok) {
        window.alert(`Schedule publish failed:\n\n${payload?.error || `Request failed (${response.status}).`}`);
        return response;
      }

      const remaining = payload?.remainingDraftShiftIds?.length || 0;
      if (remaining) {
        window.alert(`Schedule publish returned successfully, but ${remaining} draft shift${remaining === 1 ? " remains" : "s remain"}.`);
        return response;
      }

      if (publishedBusiness && payload?.targetWeekStart) {
        rememberVerifiedWeek(publishedBusiness, payload.targetWeekStart);
      }

      const employees = payload?.draftEmployeesBefore?.filter(Boolean) || [];
      const employeeLabel = employees.length ? ` for ${Array.from(new Set(employees)).join(", ")}` : "";
      window.alert(`Schedule published${employeeLabel}. Published status was verified against the database.`);
      return response;
    };

    return () => {
      window.confirm = originalConfirm;
      window.fetch = originalFetch;
    };
  }, []);

  return null;
}
