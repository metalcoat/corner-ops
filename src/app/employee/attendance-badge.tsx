"use client";

import { useCallback, useEffect, useState } from "react";

type AttendanceCountPayload = {
  count?: number;
};

export default function EmployeeAttendanceBadge() {
  const [count, setCount] = useState(0);

  const refresh = useCallback(async () => {
    if (document.visibilityState === "hidden") return;
    try {
      const response = await fetch("/api/employee/attendance/count", { cache: "no-store" });
      if (!response.ok) {
        setCount(0);
        return;
      }
      const payload = await response.json() as AttendanceCountPayload;
      setCount(Math.max(0, Number(payload.count || 0)));
    } catch {
      setCount(0);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onUpdate = () => void refresh();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("focus", onUpdate);
    window.addEventListener("corner-ops-attendance-updated", onUpdate);
    document.addEventListener("visibilitychange", onVisibilityChange);
    const interval = window.setInterval(onUpdate, 5 * 60_000);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onUpdate);
      window.removeEventListener("corner-ops-attendance-updated", onUpdate);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refresh]);

  return <a
    href="/employee/attendance"
    className="employeeAttendanceNavLink"
    aria-label={count ? `Attendance, ${count} item${count === 1 ? "" : "s"} need attention` : "Attendance"}
  >
    <span>Attendance</span>
    {count > 0 && <span className="employeeAttendanceBubble" aria-hidden="true">{count > 99 ? "99+" : count}</span>}
  </a>;
}
