"use client";

import { useEffect } from "react";

const OLD_NOTICE = "This will notify all active employees.";
const NEW_NOTICE = "Only employees whose schedules changed will be notified.";

export default function SchedulePublishConfirmFix() {
  useEffect(() => {
    const originalConfirm = window.confirm.bind(window);
    window.confirm = (message?: string) => {
      const text = typeof message === "string" && message.includes(OLD_NOTICE)
        ? message.replace(OLD_NOTICE, NEW_NOTICE)
        : message;
      return originalConfirm(text);
    };

    return () => {
      window.confirm = originalConfirm;
    };
  }, []);

  return null;
}
