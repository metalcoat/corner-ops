import type { ReactNode } from "react";
import "./reports-nav.css";

export default function ReportsLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <>
    <nav className="reportsSubnav" aria-label="Reporting areas">
      <a href="/ops/reports">Performance & weather</a>
      <a href="/ops/reports/voids">Voids & reversals</a>
    </nav>
    {children}
  </>;
}
