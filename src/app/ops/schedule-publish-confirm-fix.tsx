"use client";

import { useEffect } from "react";

const OLD_NOTICE = "This will notify all active employees.";
const NEW_NOTICE = "Only employees whose schedules changed will be notified.";

function workforceUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.pathname;
  return input.url;
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
      const url = workforceUrl(input);

      if (url.endsWith("/api/workforce") && String(init?.method || "GET").toUpperCase() === "POST" && typeof init?.body === "string") {
        try {
          const body = JSON.parse(init.body) as { action?: string };
          if (body.action === "week-publish") {
            target = "/api/workforce/week-publish-v2";
            isSchedulePublish = true;
          }
        } catch {
          // Leave unrelated or non-JSON requests untouched.
        }
      }

      const response = await originalFetch(target, init);
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

      const employees = payload?.draftEmployeesBefore?.filter(Boolean) || [];
      const employeeLabel = employees.length ? ` for ${Array.from(new Set(employees)).join(", ")}` : "";
      window.setTimeout(() => window.location.reload(), 250);
      window.alert(`Schedule published${employeeLabel}. The page will refresh to verify the draft count.`);
      return response;
    };

    return () => {
      window.confirm = originalConfirm;
      window.fetch = originalFetch;
    };
  }, []);

  return null;
}
