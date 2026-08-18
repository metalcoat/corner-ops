import type { ReactNode } from "react";
import OvernightShiftHelper from "./overnight-shift-helper";
import PayrollCostBanner from "./payroll-cost-banner";

export default function WorkforceLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <>
    <OvernightShiftHelper />
    <PayrollCostBanner />
    <nav style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", padding: "0.75rem 1rem 0", maxWidth: "1400px", margin: "0 auto" }}>
      <a href="/ops/workforce">Workforce Admin</a>
      <a href="/ops/workforce/missing-shift">+ Add Missing Shift</a>
      <a href="/ops/workforce/sms-test">Test SMS</a>
    </nav>
    {children}
  </>;
}
