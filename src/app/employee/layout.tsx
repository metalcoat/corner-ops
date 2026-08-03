import type { ReactNode } from "react";
import EmployeeMessagesDock from "./messages-dock";
import EmployeePinController from "./pin-controller";

export default function EmployeeLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="employeePortalFrame">
      <EmployeePinController />
      <EmployeeMessagesDock />
      <div className="employeePortalContent">{children}</div>
    </div>
  );
}
