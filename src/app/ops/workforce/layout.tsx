import type { ReactNode } from "react";
import OvernightShiftHelper from "./overnight-shift-helper";
import PayrollCostBanner from "./payroll-cost-banner";

export default function WorkforceLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <>
    <OvernightShiftHelper />
    <PayrollCostBanner />
    {children}
  </>;
}
