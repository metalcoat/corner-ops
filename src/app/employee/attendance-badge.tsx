"use client";

import { useCallback, useEffect, useState } from "react";

type AttendancePayload = {
  cases?: Array<{ status?: string }>;
};

export default function EmployeeAttendanceBadge() {
  const [count, setCount] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/employee/attendance", { cache: "no-store" });
      if (!response.ok) {
        setCount(0);
        return;
      }
      const payload = await response.json() as AttendancePayload;
      setCount((payload.cases || []).filter((item) =>
        ["Awaiting Correction", "Rejected"].includes(String(item.status || "")),
      ).length);
    } catch {
      setCount(0);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onUpdate = () => void refresh();
    window.addEventListener("focus", onUpdate);
    window.addEventListener("corner-ops-attendance-updated", onUpdate);
    const interval = window.setInterval(onUpdate, 60_000);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onUpdate);
      window.removeEventListener("corner-ops-attendance-updated", onUpdate);
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
