import type { ReactNode } from "react";
import PayrollCostBanner from "./payroll-cost-banner";

export default function WorkforceLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <>
    <PayrollCostBanner />
    {children}
  </>;
}
