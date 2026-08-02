import type { ReactNode } from "react";
import EmployeeMessagesDock from "./messages-dock";

export default function EmployeeLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="employeePortalFrame">
      <EmployeeMessagesDock />
      <div className="employeePortalContent">{children}</div>
    </div>
  );
}
